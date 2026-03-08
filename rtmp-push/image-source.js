const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

let stegoJs = null;
try { stegoJs = require("./stego"); } catch (_) {}

const FLV_HEADER_SIZE = 9;
const TAG_HEADER_SIZE = 11;
const PREV_TAG_SIZE_FIELD = 4;

const FFMPEG_STEGO_PATH = path.resolve(
  __dirname, "ffmpeg-stego", "ffmpeg-build", "bin", "ffmpeg"
);

function resolveFFmpeg() {
  if (fs.existsSync(FFMPEG_STEGO_PATH)) return FFMPEG_STEGO_PATH;
  return process.env.FFMPEG_BIN || "ffmpeg";
}

function hasNativeStego() {
  return fs.existsSync(FFMPEG_STEGO_PATH);
}

// --- Streaming FLV parser (reads from a readable stream) ---

class FlvStreamReader {
  constructor(stream) {
    this.stream = stream;
    this.buffer = Buffer.alloc(0);
    this.ended = false;
    this._resolve = null;

    stream.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this._resolve) {
        const r = this._resolve;
        this._resolve = null;
        r();
      }
    });

    stream.on("end", () => {
      this.ended = true;
      if (this._resolve) {
        const r = this._resolve;
        this._resolve = null;
        r();
      }
    });

    stream.pause();
  }

  async _ensureBytes(n) {
    if (this.buffer.length >= n) return true;
    this.stream.resume();
    while (this.buffer.length < n) {
      if (this.ended) {
        this.stream.pause();
        return false;
      }
      await new Promise((resolve) => {
        this._resolve = resolve;
      });
    }
    this.stream.pause();
    return true;
  }

  _consume(n) {
    const result = Buffer.from(this.buffer.subarray(0, n));
    this.buffer = this.buffer.subarray(n);
    return result;
  }

  async readHeader() {
    if (!(await this._ensureBytes(FLV_HEADER_SIZE))) return null;
    const buf = this._consume(FLV_HEADER_SIZE);

    const signature = buf.toString("ascii", 0, 3);
    if (signature !== "FLV") {
      throw new Error(`Not an FLV stream (signature: ${signature})`);
    }

    const header = {
      version: buf[3],
      hasAudio: !!(buf[4] & 0x04),
      hasVideo: !!(buf[4] & 0x01),
    };

    if (!(await this._ensureBytes(PREV_TAG_SIZE_FIELD))) return null;
    this._consume(PREV_TAG_SIZE_FIELD);

    return header;
  }

  async readTag() {
    if (!(await this._ensureBytes(TAG_HEADER_SIZE))) return null;
    const headerBuf = this._consume(TAG_HEADER_SIZE);

    const type = headerBuf[0] & 0x1f;
    const dataSize = (headerBuf[1] << 16) | (headerBuf[2] << 8) | headerBuf[3];
    const timestamp =
      (headerBuf[4] << 16) |
      (headerBuf[5] << 8) |
      headerBuf[6] |
      (headerBuf[7] << 24);

    if (!(await this._ensureBytes(dataSize))) return null;
    const data = this._consume(dataSize);

    if (!(await this._ensureBytes(PREV_TAG_SIZE_FIELD))) return null;
    this._consume(PREV_TAG_SIZE_FIELD);

    return { type, timestamp, data };
  }
}

// --- ffmpeg-based H.264 FLV tag generator ---

function getStderr(chunks) {
  const full = Buffer.concat(chunks).toString().trim();
  return full.split("\n").slice(-20).join("\n");
}

/**
 * Generate FLV tags with steganographic payload.
 *
 * When the modified FFmpeg with native stego filters is available, the
 * embedding happens inside FFmpeg via the stegoembed video filter—frames
 * are piped unmodified and the filter encodes the message into YUV pixels
 * using multi-level QIM across all three planes.
 *
 * Falls back to JS-based stego.js (green-channel QIM only) otherwise.
 */
async function* generateTags(filePath, {
  fps = 1,
  messagePath,
  holdSeconds = 30,
  qstep = 0,
  bpp = 8,
  reps = 1,
  rsNsym = 0,
} = {}) {
  const keyframeInterval = 1;
  const bmpBuf = fs.readFileSync(filePath);
  const ffmpegBin = resolveFFmpeg();
  const native = hasNativeStego() && messagePath;

  let totalChunks = 1;
  let chunks = null;
  let minFrames;

  if (native) {
    /* Native mode: FFmpeg stegoembed filter handles chunking internally.
     * We pipe the unmodified carrier BMP for enough frames. */
    minFrames = Math.max(30, holdSeconds * fps);
    console.log(`Using native stegoembed filter (${ffmpegBin})`);
  } else if (messagePath && stegoJs) {
    const msgBuf = fs.readFileSync(messagePath);
    const prepared = stegoJs.prepareChunks(bmpBuf, msgBuf);
    chunks = prepared.chunks;
    totalChunks = prepared.totalChunks;
    minFrames = totalChunks + holdSeconds * fps;
    console.log(`Using JS stego fallback (${totalChunks} chunks)`);
  } else {
    minFrames = holdSeconds * fps;
  }

  const vfFilter = native
    ? ["-vf", `stegoembed=msg=${path.resolve(messagePath)}:hold=${Math.max(1, Math.ceil(holdSeconds))}:qstep=${qstep}:bpp=${bpp}:reps=${reps}:rs=${rsNsym}`]
    : [];

  const crf = native ? "0" : "17";
  const extraParams = native
    ? ["-x264-params", "deblock=0,0"]
    : ["-tune", "stillimage"];

  const ffmpeg = spawn(
    ffmpegBin,
    [
      "-f", "image2pipe",
      "-framerate", String(fps),
      "-c:v", "bmp",
      "-i", "pipe:0",
      ...vfFilter,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      ...extraParams,
      "-crf", crf,
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      "-g", String(keyframeInterval),
      "-f", "flv",
      "-an",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );

  const stderrChunks = [];
  ffmpeg.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  const ffmpegExit = new Promise((resolve, reject) => {
    ffmpeg.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(`ffmpeg not found at ${ffmpegBin}. Build with ./ffmpeg-stego/build-ffmpeg.sh`)
        );
      } else {
        reject(err);
      }
    });
    ffmpeg.on("close", (code, signal) => resolve({ code, signal }));
  });

  const writeError = (async () => {
    for (let i = 0; i < minFrames; i++) {
      let buf;
      if (!native && chunks) {
        const ci = i % totalChunks;
        buf = stegoJs.embedChunk(bmpBuf, chunks[ci], ci, totalChunks);
        if (i < totalChunks && (i + 1) % 100 === 0) {
          console.log(`Stego embed: ${i + 1}/${totalChunks} chunks encoded...`);
        }
      } else {
        buf = bmpBuf;
      }
      const ok = ffmpeg.stdin.write(buf);
      if (!ok) {
        await new Promise((r) => ffmpeg.stdin.once("drain", r));
      }
    }
    ffmpeg.stdin.end();
  })().catch((err) => err);

  try {
    const reader = new FlvStreamReader(ffmpeg.stdout);

    const header = await reader.readHeader();
    if (!header) {
      const { code, signal } = await ffmpegExit;
      throw new Error(
        `ffmpeg produced no output (code=${code}, signal=${signal}):\n${getStderr(
          stderrChunks
        )}`
      );
    }

    const mode = native ? "native-stego" : (chunks ? "js-stego" : "plain");
    console.log(
      `FLV (ffmpeg): v${header.version}, video=${header.hasVideo}, audio=${header.hasAudio}, ` +
      `mode=${mode}, total_frames=${minFrames}`
    );

    let tag;
    while ((tag = await reader.readTag()) !== null) {
      yield tag;
    }

    const { code } = await ffmpegExit;
    if (code !== 0 && code !== null) {
      throw new Error(
        `ffmpeg exited with code ${code}:\n${getStderr(stderrChunks)}`
      );
    }
  } finally {
    ffmpeg.kill();
  }
}

module.exports = { generateTags, resolveFFmpeg, hasNativeStego };
