#!/usr/bin/env bash
#
# build-ffmpeg.sh - Clone, patch, and build FFmpeg with steganography filters
#
# Adds two custom video filters (stegoembed / stegoextract) and SEI injection
# support to libx264 encoder wrapper.
#
# Usage:
#   ./build-ffmpeg.sh [--clean]
#
# The built ffmpeg binary will be at ./ffmpeg-build/bin/ffmpeg

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FFMPEG_TAG="n7.1"
FFMPEG_REPO="https://git.ffmpeg.org/ffmpeg.git"
FFMPEG_SRC="$SCRIPT_DIR/ffmpeg-src"
FFMPEG_BUILD="$SCRIPT_DIR/ffmpeg-build"
NPROC=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)

# Portable in-place sed (macOS BSD sed vs GNU sed)
sedi() {
    if sed --version 2>/dev/null | grep -q GNU; then
        sed -i "$@"
    else
        sed -i '' "$@"
    fi
}

# ── Handle --clean ────────────────────────────────────────────────────────────

if [[ "${1:-}" == "--clean" ]]; then
    echo "Cleaning build artifacts..."
    rm -rf "$FFMPEG_SRC" "$FFMPEG_BUILD"
    echo "Done."
    exit 0
fi

# ── Step 1: Clone FFmpeg ──────────────────────────────────────────────────────

if [[ ! -d "$FFMPEG_SRC" ]]; then
    echo "=== Cloning FFmpeg ($FFMPEG_TAG) ==="
    git clone --depth 1 --branch "$FFMPEG_TAG" "$FFMPEG_REPO" "$FFMPEG_SRC"
else
    echo "=== FFmpeg source already exists, skipping clone ==="
fi

# ── Step 2: Copy filter source files ─────────────────────────────────────────

echo "=== Copying stego filter sources ==="
cp "$SCRIPT_DIR/stego_common.h"    "$FFMPEG_SRC/libavfilter/stego_common.h"
cp "$SCRIPT_DIR/vf_stegoembed.c"   "$FFMPEG_SRC/libavfilter/vf_stegoembed.c"
cp "$SCRIPT_DIR/vf_stegoextract.c" "$FFMPEG_SRC/libavfilter/vf_stegoextract.c"

# ── Step 3: Register filters in allfilters.c ─────────────────────────────────

ALLFILTERS="$FFMPEG_SRC/libavfilter/allfilters.c"

if ! grep -q "ff_vf_stegoembed" "$ALLFILTERS"; then
    echo "=== Patching allfilters.c ==="
    # Find the last ff_vf_ extern declaration and append after it
    LAST_VF_LINE=$(grep -n "extern const AVFilter ff_vf_" "$ALLFILTERS" | tail -1 | cut -d: -f1)
    if [[ -n "$LAST_VF_LINE" ]]; then
        sedi "${LAST_VF_LINE}a\\
extern const AVFilter ff_vf_stegoembed;\\
extern const AVFilter ff_vf_stegoextract;" "$ALLFILTERS"
        echo "  -> Added filter declarations after line $LAST_VF_LINE"
    else
        echo "  ERROR: No ff_vf_ declarations found in allfilters.c"
        exit 1
    fi
else
    echo "  -> allfilters.c already patched"
fi

# ── Step 4: Add build rules to Makefile ──────────────────────────────────────

MAKEFILE="$FFMPEG_SRC/libavfilter/Makefile"

if ! grep -q "STEGOEMBED" "$MAKEFILE"; then
    echo "=== Patching libavfilter/Makefile ==="
    printf '\n# Steganography filters\nOBJS-$(CONFIG_STEGOEMBED_FILTER)             += vf_stegoembed.o\nOBJS-$(CONFIG_STEGOEXTRACT_FILTER)           += vf_stegoextract.o\n' >> "$MAKEFILE"
    echo "  -> Added build rules for stego filters"
else
    echo "  -> Makefile already patched"
fi

# ── Step 5: Patch libx264.c for SEI injection ───────────────────────────────

LIBX264="$FFMPEG_SRC/libavcodec/libx264.c"

if ! grep -q "stego_sei" "$LIBX264"; then
    echo "=== Patching libx264.c for SEI injection ==="
    python3 "$SCRIPT_DIR/patch-libx264.py" "$LIBX264"
else
    echo "  -> libx264.c already patched"
fi

# ── Step 6: Configure ────────────────────────────────────────────────────────

echo "=== Configuring FFmpeg ==="
mkdir -p "$FFMPEG_BUILD"

cd "$FFMPEG_SRC"

# Check for x264 availability
X264_FLAGS=""
if pkg-config --exists x264 2>/dev/null; then
    X264_FLAGS="--enable-libx264"
    echo "  -> x264 found via pkg-config"
elif [[ -f /usr/local/lib/libx264.a ]] || [[ -f /opt/homebrew/lib/libx264.a ]]; then
    X264_FLAGS="--enable-libx264"
    echo "  -> x264 found in system paths"
else
    echo "  WARNING: x264 not found. Install with: brew install x264"
    echo "  Building without libx264 support."
fi

./configure \
    --prefix="$FFMPEG_BUILD" \
    --enable-gpl \
    ${X264_FLAGS} \
    --disable-doc \
    --disable-htmlpages \
    --disable-manpages \
    --disable-podpages \
    --disable-txtpages \
    --enable-filter=stegoembed \
    --enable-filter=stegoextract \
    --disable-programs \
    --enable-ffmpeg \
    --disable-ffplay \
    --disable-ffprobe

# ── Step 7: Build ────────────────────────────────────────────────────────────

echo "=== Building FFmpeg (using $NPROC cores) ==="
make -j"$NPROC"
make install

echo ""
echo "=== Build complete ==="
echo "FFmpeg binary: $FFMPEG_BUILD/bin/ffmpeg"
echo ""
echo "Verify stego filters:"
echo "  $FFMPEG_BUILD/bin/ffmpeg -filters 2>/dev/null | grep stego"
echo ""
echo "Lossless embed example (~3 MB/frame for 1920x1080):"
echo "  $FFMPEG_BUILD/bin/ffmpeg -loop 1 -i carrier.bmp \\"
echo "    -vf 'stegoembed=msg=secret.bin' \\"
echo "    -c:v libx264 -crf 0 -g 1 -preset ultrafast \\"
echo "    -frames:v 5 -f flv output.flv"
echo ""
echo "Robust embed example (~500 KB/frame, survives lossy compression):"
echo "  $FFMPEG_BUILD/bin/ffmpeg -loop 1 -i carrier.bmp \\"
echo "    -vf 'stegoembed=msg=secret.bin:qstep=32:bpp=2:rs=32' \\"
echo "    -c:v libx264 -crf 17 -g 1 -preset ultrafast \\"
echo "    -x264-params deblock=0,0 \\"
echo "    -frames:v 30 -f flv output.flv"
echo ""
echo "Extract:"
echo "  $FFMPEG_BUILD/bin/ffmpeg -i output.flv \\"
echo "    -vf 'stegoextract=out=recovered.bin' \\"
echo "    -f null -"
