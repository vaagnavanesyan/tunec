const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { embedMessage } = require("./stego");

const FLV_HEADER_SIZE = 9;
const TAG_HEADER_SIZE = 11;
const PREV_TAG_SIZE_FIELD = 4;

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

async function* generateTags(filePath, { fps = 1, messagePath } = {}) {
  const keyframeInterval = 1;

  let inputPath = filePath;
  let tmpFile = null;

  if (messagePath) {
    const bmpBuf = fs.readFileSync(filePath);
    const msgBuf = fs.readFileSync(messagePath);
    const modified = embedMessage(bmpBuf, msgBuf);
    tmpFile = path.join(os.tmpdir(), `stego-${process.pid}.bmp`);
    fs.writeFileSync(tmpFile, modified);
    inputPath = tmpFile;
  }

  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-loop",
      "1",
      "-i",
      inputPath,
      "-vf",
      "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "stillimage",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-g",
      String(keyframeInterval),
      "-f",
      "flv",
      "-an",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const stderrChunks = [];
  ffmpeg.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  // Resolves with exit code when ffmpeg finishes (for any reason)
  const ffmpegExit = new Promise((resolve, reject) => {
    ffmpeg.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(
          new Error("ffmpeg not found. Install ffmpeg to use H.264 encoding.")
        );
      } else {
        reject(err);
      }
    });
    ffmpeg.on("close", (code, signal) => resolve({ code, signal }));
  });

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

    console.log(
      `FLV (ffmpeg): v${header.version}, video=${header.hasVideo}, audio=${header.hasAudio}`
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
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {}
    }
  }
}

module.exports = { generateTags };
