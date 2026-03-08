/*
 * vf_stegoembed.c - FFmpeg video filter for steganographic data embedding
 *
 * Embeds arbitrary binary data into YUV420p video frames using multi-level
 * Quantization Index Modulation (QIM) across all color planes, with optional
 * Reed-Solomon forward error correction.
 *
 * Usage:
 *   ffmpeg -loop 1 -i carrier.bmp \
 *     -vf "stegoembed=msg=secret.bin:qstep=0:bpp=8" \
 *     -c:v libx264 -crf 0 -g 1 -f flv output.flv
 */

#include <stdio.h>

#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "libavutil/log.h"
#include "libavutil/internal.h"
#include "avfilter.h"
#include "filters.h"
#include "video.h"
#include "stego_common.h"

typedef struct StegoEmbedContext {
    const AVClass *class;

    /* User options */
    char *msg_path;
    int   qstep;
    int   bpp;
    int   reps;
    int   rs_nsym;
    int   hold;

    /* Internal state */
    uint8_t *msg_data;
    int      msg_len;
    uint8_t **chunks;
    int      *chunk_lens;
    int       total_chunks;
    int       chunk_cap;
    StegoRS   rs;
    int       frame_count;
} StegoEmbedContext;

#define OFFSET(x) offsetof(StegoEmbedContext, x)
#define FLAGS (AV_OPT_FLAG_VIDEO_PARAM | AV_OPT_FLAG_FILTERING_PARAM)

static const AVOption stegoembed_options[] = {
    { "msg",   "Path to message file to embed",
        OFFSET(msg_path), AV_OPT_TYPE_STRING, { .str = NULL }, 0, 0, FLAGS },
    { "qstep", "QIM quantization step (0 = lossless direct embedding)",
        OFFSET(qstep), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, 128, FLAGS },
    { "bpp",   "Bits per pixel (1-8, effective only when qstep > 0)",
        OFFSET(bpp), AV_OPT_TYPE_INT, { .i64 = 8 }, 1, 8, FLAGS },
    { "reps",  "Symbol repetition factor for majority voting",
        OFFSET(reps), AV_OPT_TYPE_INT, { .i64 = 1 }, 1, 15, FLAGS },
    { "rs",    "Reed-Solomon parity symbols per 255-byte block (0 = off)",
        OFFSET(rs_nsym), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, STG_RS_MAX_NSYM, FLAGS },
    { "hold",  "Frames to repeat each chunk",
        OFFSET(hold), AV_OPT_TYPE_INT, { .i64 = 1 }, 1, 1000, FLAGS },
    { NULL }
};

AVFILTER_DEFINE_CLASS(stegoembed);

static av_cold int stegoembed_init(AVFilterContext *ctx)
{
    StegoEmbedContext *s = ctx->priv;
    FILE *f;
    int max_levels, requested;

    if (!s->msg_path) {
        av_log(ctx, AV_LOG_ERROR, "msg parameter is required\n");
        return AVERROR(EINVAL);
    }

    f = fopen(s->msg_path, "rb");
    if (!f) {
        av_log(ctx, AV_LOG_ERROR, "Cannot open message file: %s\n", s->msg_path);
        return AVERROR(ENOENT);
    }
    fseek(f, 0, SEEK_END);
    s->msg_len = (int)ftell(f);
    fseek(f, 0, SEEK_SET);
    if (s->msg_len <= 0) {
        fclose(f);
        av_log(ctx, AV_LOG_ERROR, "Message file is empty\n");
        return AVERROR(EINVAL);
    }
    s->msg_data = av_malloc(s->msg_len);
    if (!s->msg_data) { fclose(f); return AVERROR(ENOMEM); }
    if ((int)fread(s->msg_data, 1, s->msg_len, f) != s->msg_len) {
        fclose(f);
        av_log(ctx, AV_LOG_ERROR, "Failed to read message file\n");
        return AVERROR(EIO);
    }
    fclose(f);

    if (s->rs_nsym > 0)
        stg_rs_init(&s->rs, s->rs_nsym);

    if (s->qstep > 0) {
        max_levels = s->qstep;
        requested = 1 << s->bpp;
        if (requested > max_levels) {
            av_log(ctx, AV_LOG_WARNING,
                   "bpp=%d requires %d levels but qstep=%d supports max %d, clamping\n",
                   s->bpp, requested, s->qstep, max_levels);
            while ((1 << s->bpp) > s->qstep && s->bpp > 1)
                s->bpp--;
        }
    } else {
        s->bpp = 8;
    }

    s->frame_count = 0;
    av_log(ctx, AV_LOG_INFO,
           "stegoembed: msg=%s (%d bytes), qstep=%d, bpp=%d, reps=%d, rs=%d, hold=%d\n",
           s->msg_path, s->msg_len, s->qstep, s->bpp, s->reps, s->rs_nsym, s->hold);

    return 0;
}

static int ensure_chunks(AVFilterContext *ctx, int w, int h)
{
    StegoEmbedContext *s = ctx->priv;
    int i, off, clen;

    if (s->chunks)
        return 0;

    s->chunk_cap = stg_capacity(w, h, s->bpp, s->reps, s->rs_nsym);
    if (s->chunk_cap <= 0) {
        av_log(ctx, AV_LOG_ERROR,
               "Frame %dx%d too small for any payload (bpp=%d reps=%d rs=%d)\n",
               w, h, s->bpp, s->reps, s->rs_nsym);
        return AVERROR(EINVAL);
    }

    s->total_chunks = (s->msg_len + s->chunk_cap - 1) / s->chunk_cap;
    s->chunks = av_calloc(s->total_chunks, sizeof(uint8_t *));
    s->chunk_lens = av_calloc(s->total_chunks, sizeof(int));
    if (!s->chunks || !s->chunk_lens)
        return AVERROR(ENOMEM);

    for (i = 0; i < s->total_chunks; i++) {
        off = i * s->chunk_cap;
        clen = (off + s->chunk_cap <= s->msg_len)
             ? s->chunk_cap : (s->msg_len - off);
        s->chunk_lens[i] = clen;
        s->chunks[i] = av_malloc(clen);
        if (!s->chunks[i]) return AVERROR(ENOMEM);
        memcpy(s->chunks[i], s->msg_data + off, clen);
    }

    av_log(ctx, AV_LOG_INFO,
           "stegoembed: %d bytes -> %d chunk(s), %d bytes/chunk max, frame %dx%d\n",
           s->msg_len, s->total_chunks, s->chunk_cap, w, h);

    return 0;
}

static int stegoembed_filter_frame(AVFilterLink *inlink, AVFrame *frame)
{
    AVFilterContext *ctx = inlink->dst;
    StegoEmbedContext *s = ctx->priv;
    int ret, ci, frame_buf_len, embed_len, enc_len;
    uint8_t *frame_buf, *embed_buf, *rs_buf;

    ret = ensure_chunks(ctx, frame->width, frame->height);
    if (ret < 0) { av_frame_free(&frame); return ret; }

    ret = av_frame_make_writable(frame);
    if (ret < 0) { av_frame_free(&frame); return ret; }

    ci = (s->frame_count / s->hold) % s->total_chunks;

    frame_buf_len = STEGO_OVERHEAD + s->chunk_lens[ci];
    frame_buf = av_malloc(frame_buf_len);
    if (!frame_buf) { av_frame_free(&frame); return AVERROR(ENOMEM); }

    stg_frame_build(frame_buf, ci, s->total_chunks,
                    s->chunks[ci], s->chunk_lens[ci]);

    embed_buf = frame_buf;
    embed_len = frame_buf_len;

    if (s->rs_nsym > 0) {
        enc_len = stg_rs_encoded_len(frame_buf_len, s->rs_nsym);
        rs_buf = av_malloc(enc_len);
        if (!rs_buf) { av_free(frame_buf); av_frame_free(&frame); return AVERROR(ENOMEM); }
        stg_rs_encode(&s->rs, frame_buf, frame_buf_len, rs_buf);
        embed_buf = rs_buf;
        embed_len = enc_len;
        av_free(frame_buf);
        frame_buf = NULL;
    }

    stg_embed_pixels(frame->data, frame->linesize,
                     frame->width, frame->height,
                     embed_buf, embed_len,
                     s->qstep, s->bpp, s->reps);

    av_free(embed_buf);
    s->frame_count++;

    return ff_filter_frame(ctx->outputs[0], frame);
}

static av_cold void stegoembed_uninit(AVFilterContext *ctx)
{
    StegoEmbedContext *s = ctx->priv;
    int i;

    av_freep(&s->msg_data);
    if (s->chunks) {
        for (i = 0; i < s->total_chunks; i++)
            av_freep(&s->chunks[i]);
        av_freep(&s->chunks);
    }
    av_freep(&s->chunk_lens);
}

static const enum AVPixelFormat pix_fmts[] = {
    AV_PIX_FMT_YUV420P,
    AV_PIX_FMT_NONE,
};

static const AVFilterPad stegoembed_inputs[] = {
    {
        .name         = "default",
        .type         = AVMEDIA_TYPE_VIDEO,
        .filter_frame = stegoembed_filter_frame,
    },
};

static const AVFilterPad stegoembed_outputs[] = {
    {
        .name = "default",
        .type = AVMEDIA_TYPE_VIDEO,
    },
};

const AVFilter ff_vf_stegoembed = {
    .name          = "stegoembed",
    .description   = NULL_IF_CONFIG_SMALL("Embed steganographic data into video frames using QIM"),
    .priv_size     = sizeof(StegoEmbedContext),
    .priv_class    = &stegoembed_class,
    .init          = stegoembed_init,
    .uninit        = stegoembed_uninit,
    FILTER_INPUTS(stegoembed_inputs),
    FILTER_OUTPUTS(stegoembed_outputs),
    FILTER_PIXFMTS_ARRAY(pix_fmts),
};
