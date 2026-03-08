/*
 * vf_stegoextract.c - FFmpeg video filter for steganographic data extraction
 *
 * Extracts data embedded by the stegoembed filter from YUV420p frames.
 * Collects chunks across frames and writes the reassembled message to a file.
 *
 * Usage:
 *   ffmpeg -i input.flv \
 *     -vf "stegoextract=out=recovered.bin:qstep=0:bpp=8" \
 *     -f null -
 */

#include <stdio.h>
#include <limits.h>

#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "libavutil/log.h"
#include "libavutil/internal.h"
#include "avfilter.h"
#include "filters.h"
#include "video.h"
#include "stego_common.h"

#define MAX_CHUNKS 65536

typedef struct StegoExtractContext {
    const AVClass *class;

    /* User options */
    char *out_path;
    int   qstep;
    int   bpp;
    int   reps;
    int   rs_nsym;
    int   orig_frame_len;

    /* Internal state */
    StegoRS   rs;
    uint8_t **collected;
    int      *collected_lens;
    int       total_chunks;
    int       chunks_received;
    int       frame_count;
    int       complete;
} StegoExtractContext;

#define OFFSET(x) offsetof(StegoExtractContext, x)
#define FLAGS (AV_OPT_FLAG_VIDEO_PARAM | AV_OPT_FLAG_FILTERING_PARAM)

static const AVOption stegoextract_options[] = {
    { "out",   "Output file path for extracted message",
        OFFSET(out_path), AV_OPT_TYPE_STRING, { .str = NULL }, 0, 0, FLAGS },
    { "qstep", "QIM quantization step (must match encoder)",
        OFFSET(qstep), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, 128, FLAGS },
    { "bpp",   "Bits per pixel (must match encoder)",
        OFFSET(bpp), AV_OPT_TYPE_INT, { .i64 = 8 }, 1, 8, FLAGS },
    { "reps",  "Symbol repetition factor (must match encoder)",
        OFFSET(reps), AV_OPT_TYPE_INT, { .i64 = 1 }, 1, 15, FLAGS },
    { "rs",    "Reed-Solomon parity symbols (must match encoder)",
        OFFSET(rs_nsym), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, STG_RS_MAX_NSYM, FLAGS },
    { "framelen", "Original frame buffer length before RS (for RS decode)",
        OFFSET(orig_frame_len), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, INT_MAX, FLAGS },
    { NULL }
};

AVFILTER_DEFINE_CLASS(stegoextract);

static av_cold int stegoextract_init(AVFilterContext *ctx)
{
    StegoExtractContext *s = ctx->priv;

    if (!s->out_path) {
        av_log(ctx, AV_LOG_ERROR, "out parameter is required\n");
        return AVERROR(EINVAL);
    }

    if (s->rs_nsym > 0)
        stg_rs_init(&s->rs, s->rs_nsym);

    if (s->qstep == 0)
        s->bpp = 8;

    s->collected = NULL;
    s->collected_lens = NULL;
    s->total_chunks = 0;
    s->chunks_received = 0;
    s->frame_count = 0;
    s->complete = 0;

    av_log(ctx, AV_LOG_INFO,
           "stegoextract: out=%s, qstep=%d, bpp=%d, reps=%d, rs=%d\n",
           s->out_path, s->qstep, s->bpp, s->reps, s->rs_nsym);

    return 0;
}

static int stegoextract_filter_frame(AVFilterLink *inlink, AVFrame *frame)
{
    AVFilterContext *ctx = inlink->dst;
    StegoExtractContext *s = ctx->priv;
    int w, h, y_pixels, uv_pixels, total_pixels, usable_symbols, raw_bytes;
    uint8_t *raw;
    const uint8_t *cdata[3];
    uint8_t *frame_buf;
    int frame_buf_len;
    int chunk_idx, total_chunks, data_len, ret;
    int k, nblocks, orig_len, errs;

    if (s->complete)
        goto passthrough;

    s->frame_count++;

    w = frame->width;
    h = frame->height;
    y_pixels = w * h;
    uv_pixels = (w / 2) * (h / 2) * 2;
    total_pixels = y_pixels + uv_pixels;
    usable_symbols = total_pixels / s->reps;
    raw_bytes = (usable_symbols * s->bpp) / 8;

    if (raw_bytes < STEGO_OVERHEAD) {
        av_log(ctx, AV_LOG_WARNING, "Frame too small to contain stego data\n");
        goto passthrough;
    }

    raw = av_malloc(raw_bytes);
    if (!raw) { av_frame_free(&frame); return AVERROR(ENOMEM); }

    cdata[0] = frame->data[0];
    cdata[1] = frame->data[1];
    cdata[2] = frame->data[2];
    stg_extract_pixels(cdata, frame->linesize, w, h,
                       raw, raw_bytes, s->qstep, s->bpp, s->reps);

    frame_buf = raw;
    frame_buf_len = raw_bytes;

    if (s->rs_nsym > 0) {
        k = 255 - s->rs_nsym;
        nblocks = raw_bytes / 255;
        if (nblocks < 1) {
            av_log(ctx, AV_LOG_WARNING, "Not enough data for RS block\n");
            av_free(raw);
            goto passthrough;
        }

        orig_len = s->orig_frame_len;
        if (orig_len <= 0)
            orig_len = nblocks * k;

        errs = stg_rs_decode(&s->rs, raw, nblocks * 255, orig_len);
        if (errs < 0) {
            av_log(ctx, AV_LOG_WARNING,
                   "RS decode failed on frame %d\n", s->frame_count);
            av_free(raw);
            goto passthrough;
        }
        if (errs > 0)
            av_log(ctx, AV_LOG_INFO,
                   "RS corrected %d errors on frame %d\n", errs, s->frame_count);

        frame_buf_len = orig_len;
    }

    ret = stg_frame_parse(frame_buf, frame_buf_len,
                          &chunk_idx, &total_chunks, &data_len);
    if (ret < 0) {
        av_log(ctx, AV_LOG_WARNING,
               "Frame %d: stego parse failed (code %d)\n",
               s->frame_count, ret);
        av_free(raw);
        goto passthrough;
    }

    if (!s->collected && total_chunks > 0 && total_chunks <= MAX_CHUNKS) {
        s->total_chunks = total_chunks;
        s->collected = av_calloc(total_chunks, sizeof(uint8_t *));
        s->collected_lens = av_calloc(total_chunks, sizeof(int));
        if (!s->collected || !s->collected_lens) {
            av_free(raw);
            goto passthrough;
        }
    }

    if (s->collected && chunk_idx >= 0 && chunk_idx < s->total_chunks &&
        !s->collected[chunk_idx]) {
        s->collected[chunk_idx] = av_malloc(data_len);
        if (!s->collected[chunk_idx]) {
            av_free(raw);
            goto passthrough;
        }
        memcpy(s->collected[chunk_idx], frame_buf + STEGO_HDR_SIZE, data_len);
        s->collected_lens[chunk_idx] = data_len;
        s->chunks_received++;

        av_log(ctx, AV_LOG_INFO,
               "Frame %d: chunk %d/%d extracted (%d bytes)\n",
               s->frame_count, chunk_idx + 1, total_chunks, data_len);

        if (s->chunks_received >= s->total_chunks) {
            s->complete = 1;
            av_log(ctx, AV_LOG_INFO,
                   "All %d chunks received\n", s->total_chunks);
        }
    } else if (s->collected && chunk_idx >= 0 && chunk_idx < s->total_chunks) {
        av_log(ctx, AV_LOG_DEBUG,
               "Frame %d: chunk %d/%d duplicate, skipping\n",
               s->frame_count, chunk_idx + 1, total_chunks);
    }

    av_free(raw);

passthrough:
    return ff_filter_frame(ctx->outputs[0], frame);
}

static av_cold void stegoextract_uninit(AVFilterContext *ctx)
{
    StegoExtractContext *s = ctx->priv;
    int i, total_len, off;
    uint8_t *output;
    FILE *f;

    if (s->collected && s->chunks_received > 0) {
        if (s->chunks_received < s->total_chunks) {
            av_log(ctx, AV_LOG_WARNING,
                   "Incomplete: %d/%d chunks received\n",
                   s->chunks_received, s->total_chunks);
        }

        total_len = 0;
        for (i = 0; i < s->total_chunks; i++)
            if (s->collected[i])
                total_len += s->collected_lens[i];

        if (total_len > 0) {
            output = av_malloc(total_len);
            if (output) {
                off = 0;
                for (i = 0; i < s->total_chunks; i++) {
                    if (s->collected[i]) {
                        memcpy(output + off, s->collected[i],
                               s->collected_lens[i]);
                        off += s->collected_lens[i];
                    }
                }

                f = fopen(s->out_path, "wb");
                if (f) {
                    fwrite(output, 1, total_len, f);
                    fclose(f);
                    av_log(ctx, AV_LOG_INFO,
                           "Wrote %d bytes to %s (%d/%d chunks)\n",
                           total_len, s->out_path,
                           s->chunks_received, s->total_chunks);
                } else {
                    av_log(ctx, AV_LOG_ERROR,
                           "Cannot write output file: %s\n", s->out_path);
                }
                av_free(output);
            }
        }
    } else if (s->collected) {
        av_log(ctx, AV_LOG_WARNING, "No chunks were extracted\n");
    }

    if (s->collected) {
        for (i = 0; i < s->total_chunks; i++)
            av_freep(&s->collected[i]);
        av_freep(&s->collected);
    }
    av_freep(&s->collected_lens);
}

static const enum AVPixelFormat pix_fmts[] = {
    AV_PIX_FMT_YUV420P,
    AV_PIX_FMT_NONE,
};

static const AVFilterPad stegoextract_inputs[] = {
    {
        .name         = "default",
        .type         = AVMEDIA_TYPE_VIDEO,
        .filter_frame = stegoextract_filter_frame,
    },
};

static const AVFilterPad stegoextract_outputs[] = {
    {
        .name = "default",
        .type = AVMEDIA_TYPE_VIDEO,
    },
};

const AVFilter ff_vf_stegoextract = {
    .name          = "stegoextract",
    .description   = NULL_IF_CONFIG_SMALL("Extract steganographic data from video frames"),
    .priv_size     = sizeof(StegoExtractContext),
    .priv_class    = &stegoextract_class,
    .init          = stegoextract_init,
    .uninit        = stegoextract_uninit,
    FILTER_INPUTS(stegoextract_inputs),
    FILTER_OUTPUTS(stegoextract_outputs),
    FILTER_PIXFMTS_ARRAY(pix_fmts),
};
