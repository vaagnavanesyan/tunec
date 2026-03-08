#!/usr/bin/env python3
"""
Patch FFmpeg's libavcodec/libx264.c to add SEI steganography injection.

Adds:
1. stego_sei_path, stego_sei_buf, stego_sei_len fields to X264Context
2. AVOption for stego_sei
3. SEI file loading after encoder init
4. SEI injection before each x264_encoder_encode call
5. Cleanup in close function
"""

import sys
import re


def patch_libx264(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    if 'stego_sei' in content:
        print(f"  -> {filepath} already patched, skipping")
        return

    # 1. Add fields to X264Context struct
    #    FFmpeg n7.1 uses: AVDictionary *x264_params;
    anchor = re.search(r'(AVDictionary\s+\*x264_params;)', content)
    if not anchor:
        anchor = re.search(r'(char\s+\*x264_params;)', content)
    if anchor:
        insert_pos = anchor.end()
        fields = "\n    char *stego_sei_path;\n    uint8_t *stego_sei_buf;\n    int stego_sei_len;"
        content = content[:insert_pos] + fields + content[insert_pos:]
        print("  -> Added stego_sei fields to X264Context")
    else:
        print("  WARNING: Could not find x264_params field anchor")
        return

    # 2. Add AVOption before the terminating { NULL } in options[]
    option_entry = '    { "stego_sei", "Path to file with data to inject as H.264 SEI user_data_unregistered",\n      OFFSET(stego_sei_path), AV_OPT_TYPE_STRING, { .str = NULL }, 0, 0, VE },\n'

    null_match = re.search(r'(\n(\s*)\{\s*NULL\s*\},?\s*\n\s*\};)', content)
    if null_match:
        insert_pos = null_match.start()
        content = content[:insert_pos] + '\n' + option_entry + content[insert_pos:]
        print("  -> Added stego_sei AVOption")
    else:
        print("  WARNING: Could not find options array terminator")

    # 3. Add SEI file loading after encoder open
    encoder_open = re.search(
        r'(x4->enc\s*=\s*x264_encoder_open[^;]*;\s*\n\s*if\s*\(\s*!x4->enc\s*\)[^}]*\})',
        content, re.DOTALL
    )
    if encoder_open:
        insert_pos = encoder_open.end()
        load_code = """

    /* Load SEI steganography payload */
    if (x4->stego_sei_path) {
        FILE *sei_f;
        sei_f = fopen(x4->stego_sei_path, "rb");
        if (sei_f) {
            fseek(sei_f, 0, SEEK_END);
            x4->stego_sei_len = (int)ftell(sei_f);
            fseek(sei_f, 0, SEEK_SET);
            x4->stego_sei_buf = av_malloc(x4->stego_sei_len);
            if (x4->stego_sei_buf)
                fread(x4->stego_sei_buf, 1, x4->stego_sei_len, sei_f);
            fclose(sei_f);
            av_log(avctx, AV_LOG_INFO, "Loaded %d bytes of SEI stego data\\n",
                   x4->stego_sei_len);
        } else {
            av_log(avctx, AV_LOG_WARNING, "Cannot open SEI file: %s\\n",
                   x4->stego_sei_path);
        }
    }"""
        content = content[:insert_pos] + load_code + content[insert_pos:]
        print("  -> Added SEI file loading code")
    else:
        print("  WARNING: Could not find x264_encoder_open anchor")

    # 4. Add SEI injection before x264_encoder_encode
    encode_call = re.search(
        r'(\n(\s*))(ret\s*=\s*x264_encoder_encode\s*\()',
        content
    )
    if encode_call:
        indent = encode_call.group(2)
        insert_pos = encode_call.start()
        sei_code = (
            f"\n{indent}{{\n"
            f"{indent}    /* Inject SEI user_data_unregistered for steganography */\n"
            f"{indent}    static const uint8_t stego_uuid[16] = {{\n"
            f"{indent}        0x53,0x54,0x45,0x47,0x4f,0x53,0x45,0x49,\n"
            f"{indent}        0x2d,0x56,0x31,0x2e,0x30,0x2e,0x30,0x00\n"
            f"{indent}    }};\n"
            f"{indent}    x264_sei_payload_t stego_sei_payload;\n"
            f"{indent}    x264_sei_t stego_sei_data = {{ 0, NULL }};\n"
            f"{indent}    uint8_t *stego_sei_combined = NULL;\n"
            f"{indent}    if (x4->stego_sei_buf && x4->stego_sei_len > 0) {{\n"
            f"{indent}        stego_sei_combined = av_malloc(16 + x4->stego_sei_len);\n"
            f"{indent}        if (stego_sei_combined) {{\n"
            f"{indent}            memcpy(stego_sei_combined, stego_uuid, 16);\n"
            f"{indent}            memcpy(stego_sei_combined + 16, x4->stego_sei_buf, x4->stego_sei_len);\n"
            f"{indent}            stego_sei_payload.payload_size = 16 + x4->stego_sei_len;\n"
            f"{indent}            stego_sei_payload.payload_type = 5;\n"
            f"{indent}            stego_sei_payload.payload = stego_sei_combined;\n"
            f"{indent}            stego_sei_data.num_payloads = 1;\n"
            f"{indent}            stego_sei_data.payloads = &stego_sei_payload;\n"
            f"{indent}            x4->pic.extra_sei = stego_sei_data;\n"
            f"{indent}        }}\n"
            f"{indent}    }}\n"
        )
        content = content[:insert_pos] + sei_code + content[insert_pos:]
        print("  -> Added SEI injection before encode")

        # Add cleanup after encode call (search from after the inserted code)
        search_start = insert_pos + len(sei_code)
        encode_after = re.search(
            r'(ret\s*=\s*x264_encoder_encode\s*\([^;]*;)',
            content[search_start:]
        )
        if encode_after:
            cleanup_pos = search_start + encode_after.end()
            cleanup = f"\n{indent}    av_freep(&stego_sei_combined);\n{indent}}}"
            content = content[:cleanup_pos] + cleanup + content[cleanup_pos:]
            print("  -> Added SEI cleanup after encode")
    else:
        print("  WARNING: Could not find x264_encoder_encode call")

    # 5. Add free in close function (after av_freep(&x4->sei))
    close_free = re.search(r'(av_freep\s*\(\s*&x4->sei\s*\)\s*;)', content)
    if close_free:
        insert_pos = close_free.end()
        content = content[:insert_pos] + "\n    av_freep(&x4->stego_sei_buf);" + content[insert_pos:]
        print("  -> Added SEI buffer cleanup in close")
    else:
        print("  WARNING: Could not find sei free anchor in close function")

    with open(filepath, 'w') as f:
        f.write(content)

    print(f"  -> Patch complete: {filepath}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <path/to/libx264.c>")
        sys.exit(1)
    patch_libx264(sys.argv[1])
