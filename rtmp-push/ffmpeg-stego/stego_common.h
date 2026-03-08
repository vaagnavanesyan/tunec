/*
 * stego_common.h - Shared steganography utilities for FFmpeg filters
 *
 * Provides: CRC32, GF(2^8) arithmetic, Reed-Solomon codec,
 *           multi-level QIM encoding/decoding, frame format helpers.
 *
 * All functions are static to avoid linker conflicts when included
 * from multiple compilation units within FFmpeg.
 *
 * NOTE: Uses C89-style declarations (variables at top of block) to
 * satisfy FFmpeg's -Wdeclaration-after-statement requirement.
 */

#ifndef AVFILTER_STEGO_COMMON_H
#define AVFILTER_STEGO_COMMON_H

#include <stdint.h>
#include <string.h>
#include <stdlib.h>

/* ── Frame format constants ───────────────────────────────── */

#define STEGO_MAGIC_0   0x53  /* 'S' */
#define STEGO_MAGIC_1   0x54  /* 'T' */
#define STEGO_MAGIC_2   0x45  /* 'E' */
#define STEGO_MAGIC_3   0x47  /* 'G' */
#define STEGO_HDR_SIZE  12    /* magic(4) + chunk_idx(2) + total(2) + len(4) */
#define STEGO_CRC_SIZE  4
#define STEGO_OVERHEAD  (STEGO_HDR_SIZE + STEGO_CRC_SIZE)

/* ── Reed-Solomon limits ──────────────────────────────────── */

#define STG_RS_MAX_NSYM  64
#define STG_GF_PRIM_POLY 0x11d

/* ── Little-endian helpers ────────────────────────────────── */

static inline void stg_write_le16(uint8_t *p, uint16_t v) {
    p[0] = v & 0xFF; p[1] = (v >> 8) & 0xFF;
}

static inline void stg_write_le32(uint8_t *p, uint32_t v) {
    p[0] = v & 0xFF; p[1] = (v >> 8) & 0xFF;
    p[2] = (v >> 16) & 0xFF; p[3] = (v >> 24) & 0xFF;
}

static inline uint16_t stg_read_le16(const uint8_t *p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static inline uint32_t stg_read_le32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* ── CRC32 (ISO 3309) ────────────────────────────────────── */

static uint32_t stg_crc32(const uint8_t *data, int len) {
    uint32_t crc = 0xFFFFFFFF;
    int i, j;
    for (i = 0; i < len; i++) {
        crc ^= data[i];
        for (j = 0; j < 8; j++)
            crc = (crc >> 1) ^ (crc & 1 ? 0xEDB88320u : 0);
    }
    return crc ^ 0xFFFFFFFF;
}

/* ── GF(2^8) arithmetic ──────────────────────────────────── */

static uint8_t stg_gf_exp[512];
static uint8_t stg_gf_log[256];
static int stg_gf_ready = 0;

static void stg_gf_init(void) {
    int x = 1;
    int i;
    if (stg_gf_ready) return;
    for (i = 0; i < 255; i++) {
        stg_gf_exp[i] = (uint8_t)x;
        stg_gf_log[x] = (uint8_t)i;
        x <<= 1;
        if (x & 0x100) x ^= STG_GF_PRIM_POLY;
    }
    for (i = 255; i < 512; i++)
        stg_gf_exp[i] = stg_gf_exp[i - 255];
    stg_gf_log[0] = 0;
    stg_gf_ready = 1;
}

static inline uint8_t stg_gf_mul(uint8_t a, uint8_t b) {
    if (a == 0 || b == 0) return 0;
    return stg_gf_exp[stg_gf_log[a] + stg_gf_log[b]];
}

static inline uint8_t stg_gf_div(uint8_t a, uint8_t b) {
    if (a == 0 || b == 0) return 0;
    return stg_gf_exp[(stg_gf_log[a] + 255 - stg_gf_log[b]) % 255];
}

static inline uint8_t stg_gf_pow(uint8_t a, int n) {
    int e;
    if (a == 0) return 0;
    e = (stg_gf_log[a] * n) % 255;
    if (e < 0) e += 255;
    return stg_gf_exp[e];
}

static inline uint8_t stg_gf_inv(uint8_t a) {
    if (a == 0) return 0;
    return stg_gf_exp[255 - stg_gf_log[a]];
}

/* ── Reed-Solomon codec ───────────────────────────────────── */

typedef struct StegoRS {
    int nsym;
    uint8_t gen[STG_RS_MAX_NSYM + 1];
} StegoRS;

static void stg_rs_init(StegoRS *rs, int nsym) {
    int i, j;
    stg_gf_init();
    rs->nsym = nsym;
    memset(rs->gen, 0, sizeof(rs->gen));
    rs->gen[0] = 1;
    for (i = 0; i < nsym; i++) {
        for (j = nsym; j > 0; j--)
            rs->gen[j] = rs->gen[j - 1] ^ stg_gf_mul(rs->gen[j], stg_gf_exp[i]);
        rs->gen[0] = stg_gf_mul(rs->gen[0], stg_gf_exp[i]);
    }
}

static void stg_rs_encode_block(const StegoRS *rs, const uint8_t *data,
                                int k, uint8_t *parity) {
    int nsym = rs->nsym;
    uint8_t lfsr[STG_RS_MAX_NSYM];
    int i, j;
    uint8_t fb;
    memset(lfsr, 0, nsym);
    for (i = 0; i < k; i++) {
        fb = data[i] ^ lfsr[nsym - 1];
        for (j = nsym - 1; j > 0; j--)
            lfsr[j] = lfsr[j - 1] ^ stg_gf_mul(fb, rs->gen[j]);
        lfsr[0] = stg_gf_mul(fb, rs->gen[0]);
    }
    for (i = 0; i < nsym; i++)
        parity[i] = lfsr[nsym - 1 - i];
}

static void stg_rs_syndromes(const uint8_t *msg, int n, int nsym,
                             uint8_t *synd) {
    int i, j;
    for (i = 0; i < nsym; i++) {
        synd[i] = 0;
        for (j = 0; j < n; j++)
            synd[i] = stg_gf_mul(synd[i], stg_gf_exp[i]) ^ msg[j];
    }
}

static int stg_rs_synd_is_zero(const uint8_t *synd, int nsym) {
    int i;
    for (i = 0; i < nsym; i++)
        if (synd[i]) return 0;
    return 1;
}

static int stg_rs_berlekamp_massey(const uint8_t *synd, int nsym,
                                   uint8_t *sigma) {
    uint8_t B[STG_RS_MAX_NSYM + 1], T[STG_RS_MAX_NSYM + 1];
    int L = 0, m = 1, n, i, j;
    uint8_t b = 1, d, coef;

    memset(sigma, 0, nsym + 1);
    memset(B, 0, nsym + 1);
    sigma[0] = 1;
    B[0] = 1;

    for (n = 0; n < nsym; n++) {
        d = synd[n];
        for (i = 1; i <= L; i++)
            d ^= stg_gf_mul(sigma[i], synd[n - i]);
        if (d == 0) {
            m++;
            continue;
        }
        memcpy(T, sigma, nsym + 1);
        coef = stg_gf_div(d, b);
        for (j = m; j <= nsym; j++)
            sigma[j] ^= stg_gf_mul(coef, B[j - m]);
        if (2 * L <= n) {
            L = n + 1 - L;
            memcpy(B, T, nsym + 1);
            b = d;
            m = 1;
        } else {
            m++;
        }
    }
    return L;
}

static int stg_rs_chien_search(const uint8_t *sigma, int deg, int n,
                               int *err_pos) {
    int found = 0, p, j, k, idx;
    uint8_t val;
    for (p = 0; p < 255; p++) {
        val = 1;
        for (j = 1; j <= deg; j++)
            val ^= stg_gf_mul(sigma[j], stg_gf_exp[(p * j) % 255]);
        if (val == 0) {
            k = (255 - p) % 255;
            idx = n - 1 - k;
            if (idx >= 0 && idx < n)
                err_pos[found++] = idx;
        }
    }
    return found;
}

static void stg_rs_forney(const uint8_t *synd, int nsym,
                          const uint8_t *sigma, int nerr,
                          const int *err_pos, int n,
                          uint8_t *err_mag) {
    uint8_t omega[STG_RS_MAX_NSYM];
    int i, j, pos, k;
    uint8_t Xi, Xi_inv, omega_val, xp, sp;

    memset(omega, 0, nsym);
    for (i = 0; i < nsym; i++)
        for (j = 0; j <= i && j <= nerr; j++)
            omega[i] ^= stg_gf_mul(sigma[j], synd[i - j]);

    for (i = 0; i < nerr; i++) {
        pos = err_pos[i];
        k = n - 1 - pos;
        Xi = stg_gf_exp[k % 255];
        Xi_inv = stg_gf_exp[(255 - k % 255) % 255];

        omega_val = 0;
        xp = 1;
        for (j = 0; j < nsym; j++) {
            omega_val ^= stg_gf_mul(omega[j], xp);
            xp = stg_gf_mul(xp, Xi_inv);
        }

        sp = 0;
        xp = 1;
        for (j = 1; j <= nerr; j += 2) {
            sp ^= stg_gf_mul(sigma[j], xp);
            xp = stg_gf_mul(xp, stg_gf_mul(Xi_inv, Xi_inv));
        }

        err_mag[i] = stg_gf_mul(Xi, stg_gf_div(omega_val, sp));
    }
}

static int stg_rs_decode_block(const StegoRS *rs, uint8_t *msg, int n) {
    int nsym = rs->nsym;
    uint8_t synd[STG_RS_MAX_NSYM];
    uint8_t sigma[STG_RS_MAX_NSYM + 1];
    int err_pos[STG_RS_MAX_NSYM];
    uint8_t err_mag[STG_RS_MAX_NSYM];
    int nerr, found, i;

    stg_rs_syndromes(msg, n, nsym, synd);
    if (stg_rs_synd_is_zero(synd, nsym))
        return 0;

    nerr = stg_rs_berlekamp_massey(synd, nsym, sigma);
    if (nerr > nsym / 2)
        return -1;

    found = stg_rs_chien_search(sigma, nerr, n, err_pos);
    if (found != nerr)
        return -1;

    stg_rs_forney(synd, nsym, sigma, nerr, err_pos, n, err_mag);

    for (i = 0; i < nerr; i++) {
        if (err_pos[i] < 0 || err_pos[i] >= n)
            return -1;
        msg[err_pos[i]] ^= err_mag[i];
    }

    stg_rs_syndromes(msg, n, nsym, synd);
    if (!stg_rs_synd_is_zero(synd, nsym))
        return -1;

    return nerr;
}

static int stg_rs_encoded_len(int data_len, int nsym) {
    int k = 255 - nsym;
    int nblocks = (data_len + k - 1) / k;
    return nblocks * 255;
}

static int stg_rs_encode(const StegoRS *rs, const uint8_t *in, int in_len,
                         uint8_t *out) {
    int nsym = rs->nsym;
    int k = 255 - nsym;
    int nblocks = (in_len + k - 1) / k;
    int i, off, bk;
    uint8_t block[255];
    uint8_t parity[STG_RS_MAX_NSYM];

    for (i = 0; i < nblocks; i++) {
        off = i * k;
        bk = (off + k <= in_len) ? k : (in_len - off);
        memcpy(block, in + off, bk);
        if (bk < k) memset(block + bk, 0, k - bk);
        stg_rs_encode_block(rs, block, k, parity);
        memcpy(out + i * 255, block, k);
        memcpy(out + i * 255 + k, parity, nsym);
    }
    return nblocks * 255;
}

static int stg_rs_decode(const StegoRS *rs, uint8_t *inout, int total_len,
                         int orig_data_len) {
    int nsym = rs->nsym;
    int k = 255 - nsym;
    int nblocks = total_len / 255;
    int total_errs = 0;
    int i, errs, bk, last;

    for (i = 0; i < nblocks; i++) {
        errs = stg_rs_decode_block(rs, inout + i * 255, 255);
        if (errs < 0) return -1;
        total_errs += errs;
    }
    for (i = 0; i < nblocks; i++) {
        bk = k;
        if (i == nblocks - 1) {
            last = orig_data_len - i * k;
            if (last > 0 && last < k) bk = last;
        }
        if (i > 0)
            memmove(inout + i * k, inout + i * 255, bk);
    }
    return total_errs;
}

/* ── Multi-level QIM ──────────────────────────────────────── */

static inline uint8_t stg_qim_encode(uint8_t v, uint8_t sym,
                                     int qstep, int levels) {
    int step, target_rem, cur_rem, diff, result;
    if (!qstep) return sym;
    step = qstep / levels;
    if (step < 1) step = 1;
    target_rem = sym * step;
    cur_rem = ((int)v % qstep + qstep) % qstep;
    diff = target_rem - cur_rem;
    if (diff > qstep / 2) diff -= qstep;
    if (diff < -(qstep / 2)) diff += qstep;
    result = (int)v + diff;
    if (result < 0) result = 0;
    if (result > 255) result = 255;
    return (uint8_t)result;
}

static inline uint8_t stg_qim_decode(uint8_t v, int qstep, int levels) {
    int step, r, s;
    if (!qstep) return v;
    step = qstep / levels;
    if (step < 1) step = 1;
    r = ((int)v % qstep + qstep) % qstep;
    s = (r + step / 2) / step;
    if (s >= levels) s = 0;
    return (uint8_t)s;
}

/* ── Frame header build / parse ───────────────────────────── */

static int stg_frame_build(uint8_t *out, int chunk_idx, int total_chunks,
                           const uint8_t *data, int data_len) {
    out[0] = STEGO_MAGIC_0;
    out[1] = STEGO_MAGIC_1;
    out[2] = STEGO_MAGIC_2;
    out[3] = STEGO_MAGIC_3;
    stg_write_le16(out + 4, (uint16_t)chunk_idx);
    stg_write_le16(out + 6, (uint16_t)total_chunks);
    stg_write_le32(out + 8, (uint32_t)data_len);
    memcpy(out + STEGO_HDR_SIZE, data, data_len);
    stg_write_le32(out + STEGO_HDR_SIZE + data_len, stg_crc32(data, data_len));
    return STEGO_OVERHEAD + data_len;
}

static int stg_frame_parse(const uint8_t *buf, int buf_len,
                           int *chunk_idx, int *total_chunks, int *data_len) {
    uint32_t stored_crc, actual_crc;
    if (buf_len < STEGO_HDR_SIZE)
        return -1;
    if (buf[0] != STEGO_MAGIC_0 || buf[1] != STEGO_MAGIC_1 ||
        buf[2] != STEGO_MAGIC_2 || buf[3] != STEGO_MAGIC_3)
        return -2;
    *chunk_idx = stg_read_le16(buf + 4);
    *total_chunks = stg_read_le16(buf + 6);
    *data_len = (int)stg_read_le32(buf + 8);
    if (*data_len < 0 || STEGO_OVERHEAD + *data_len > buf_len)
        return -3;
    stored_crc = stg_read_le32(buf + STEGO_HDR_SIZE + *data_len);
    actual_crc = stg_crc32(buf + STEGO_HDR_SIZE, *data_len);
    if (stored_crc != actual_crc)
        return -4;
    return 0;
}

/* ── Capacity computation ─────────────────────────────────── */

static int stg_capacity(int w, int h, int bpp, int reps, int rs_nsym) {
    int y_pixels = w * h;
    int uv_pixels = (w / 2) * (h / 2) * 2;
    int total_pixels = y_pixels + uv_pixels;
    int usable_symbols = total_pixels / reps;
    int raw_bytes = (usable_symbols * bpp) / 8;

    if (rs_nsym > 0) {
        int k = 255 - rs_nsym;
        int nblocks = raw_bytes / 255;
        if (nblocks < 1) return 0;
        raw_bytes = nblocks * k;
    }

    return raw_bytes - STEGO_OVERHEAD;
}

/* ── Pixel embedding / extraction ─────────────────────────── */

static void stg_embed_pixels(uint8_t *data[3], const int linesize[3],
                             int w, int h,
                             const uint8_t *buf, int buf_len,
                             int qstep, int bpp, int reps) {
    int levels = qstep ? (1 << bpp) : 256;
    int total_bits = buf_len * 8;
    int bit_idx = 0;
    int rep_ctr = 0;
    uint8_t sym = 0;
    int sym_loaded = 0;
    int plane_w[3], plane_h[3];
    int p, y, x, b, bi, byte_pos, bit_pos;
    uint8_t *row;

    plane_w[0] = w;     plane_w[1] = w / 2; plane_w[2] = w / 2;
    plane_h[0] = h;     plane_h[1] = h / 2; plane_h[2] = h / 2;

    for (p = 0; p < 3; p++) {
        for (y = 0; y < plane_h[p]; y++) {
            row = data[p] + y * linesize[p];
            for (x = 0; x < plane_w[p]; x++) {
                if (!sym_loaded) {
                    if (bit_idx >= total_bits)
                        return;
                    sym = 0;
                    for (b = 0; b < bpp; b++) {
                        bi = bit_idx + b;
                        if (bi < total_bits) {
                            byte_pos = bi / 8;
                            bit_pos = 7 - (bi % 8);
                            sym |= ((buf[byte_pos] >> bit_pos) & 1) << (bpp - 1 - b);
                        }
                    }
                    bit_idx += bpp;
                    rep_ctr = 0;
                    sym_loaded = 1;
                }
                row[x] = stg_qim_encode(row[x], sym, qstep, levels);
                rep_ctr++;
                if (rep_ctr >= reps)
                    sym_loaded = 0;
            }
        }
    }
}

static void stg_extract_pixels(const uint8_t *data[3], const int linesize[3],
                               int w, int h,
                               uint8_t *buf, int buf_len,
                               int qstep, int bpp, int reps) {
    int levels = qstep ? (1 << bpp) : 256;
    int total_bits = buf_len * 8;
    int bit_idx = 0;
    int rep_ctr = 0;
    int votes[256];
    int plane_w[3], plane_h[3];
    int p, y, x, i, b, bi, byte_pos, bit_pos, best_cnt;
    uint8_t s, best;
    const uint8_t *row;

    memset(votes, 0, sizeof(votes));
    memset(buf, 0, buf_len);

    plane_w[0] = w;     plane_w[1] = w / 2; plane_w[2] = w / 2;
    plane_h[0] = h;     plane_h[1] = h / 2; plane_h[2] = h / 2;

    for (p = 0; p < 3; p++) {
        for (y = 0; y < plane_h[p]; y++) {
            row = data[p] + y * linesize[p];
            for (x = 0; x < plane_w[p]; x++) {
                if (bit_idx >= total_bits)
                    return;

                s = stg_qim_decode(row[x], qstep, levels);
                if (s < levels)
                    votes[s]++;
                rep_ctr++;

                if (rep_ctr >= reps) {
                    best = 0;
                    best_cnt = 0;
                    for (i = 0; i < levels; i++) {
                        if (votes[i] > best_cnt) {
                            best_cnt = votes[i];
                            best = (uint8_t)i;
                        }
                    }
                    for (b = 0; b < bpp && bit_idx < total_bits; b++) {
                        bi = bit_idx + b;
                        byte_pos = bi / 8;
                        bit_pos = 7 - (bi % 8);
                        if (best & (1 << (bpp - 1 - b)))
                            buf[byte_pos] |= (1 << bit_pos);
                    }
                    bit_idx += bpp;
                    rep_ctr = 0;
                    memset(votes, 0, levels * sizeof(int));
                }
            }
        }
    }
}

#endif /* AVFILTER_STEGO_COMMON_H */
