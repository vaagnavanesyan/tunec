const fs = require("fs");
const { spawn } = require("child_process");
const { prepareChunks, embedChunk } = require("./stego");

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

async function* generateTags(filePath, { fps = 1, messagePath, holdSeconds = 30 } = {}) {
  const keyframeInterval = 1;
  const bmpBuf = fs.readFileSync(filePath);

  let chunks = null;
  let totalChunks = 1;
  if (messagePath) {
    const msgBuf = fs.readFileSync(messagePath);
    const prepared = prepareChunks(bmpBuf, msgBuf);
    chunks = prepared.chunks;
    totalChunks = prepared.totalChunks;
  }

  const minFrames = totalChunks + holdSeconds * fps;

  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-f", "image2pipe",
      "-framerate", String(fps),
      "-c:v", "bmp",
      "-i", "pipe:0",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "stillimage",
      "-crf", "17",
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
          new Error("ffmpeg not found. Install ffmpeg to use H.264 encoding.")
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
      if (chunks) {
        const ci = i % totalChunks;
        buf = embedChunk(bmpBuf, chunks[ci], ci, totalChunks);
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

    console.log(
      `FLV (ffmpeg): v${header.version}, video=${header.hasVideo}, audio=${header.hasAudio}, ` +
      `chunks=${totalChunks}, total_frames=${minFrames}`
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

module.exports = { generateTags };
