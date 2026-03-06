const fs = require("fs");
const { spawn } = require("child_process");
const { extractChunk, reassembleChunks } = require("./stego");

const DEFAULT_URL = "rtmp://localhost:1935/live/test";

const rtmpUrl = process.argv[2] || process.env.RTMP_URL || DEFAULT_URL;
const expectedMessagePath = process.argv[3] || "message.bin";

function grabFrames(source, { timeoutMs = 600_000 } = {}) {
  console.log(`Grabbing frames from: ${source}`);

  const args = [
    "-loglevel", "warning",
    "-rw_timeout", "15000000",
    "-analyzeduration", "0",
    "-probesize", "32",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-i", source,
    "-f", "image2pipe",
    "-c:v", "bmp",
    "pipe:1",
  ];

  const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  let killed = false;
  const kill = () => {
    if (!killed) {
      killed = true;
      ffmpeg.kill();
    }
  };

  const killTimer = setTimeout(() => {
    kill();
  }, timeoutMs);

  const stderrChunks = [];
  ffmpeg.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  const exitPromise = new Promise((resolve) => {
    ffmpeg.on("close", (code) => resolve(code));
  });

  ffmpeg.on("error", (err) => {
    clearTimeout(killTimer);
    if (err.code === "ENOENT") {
      console.error("ffmpeg not found. Install ffmpeg first.");
    }
  });

  return {
    frames: parseBmpStream(ffmpeg.stdout),
    kill,
    cleanup: () => {
      clearTimeout(killTimer);
      kill();
    },
    exitPromise,
  };
}

async function* parseBmpStream(stream) {
  let buf = Buffer.alloc(0);
  let done = false;
  let waitResolve = null;

  stream.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (waitResolve) {
      const r = waitResolve;
      waitResolve = null;
      r();
    }
  });

  stream.on("end", () => {
    done = true;
    if (waitResolve) {
      const r = waitResolve;
      waitResolve = null;
      r();
    }
  });

  async function ensureBytes(n) {
    while (buf.length < n) {
      if (done) return false;
      await new Promise((resolve) => { waitResolve = resolve; });
    }
    return true;
  }

  while (true) {
    if (!(await ensureBytes(6))) break;
    if (buf[0] !== 0x42 || buf[1] !== 0x4d) break;

    const bmpSize = buf.readUInt32LE(2);
    if (!(await ensureBytes(bmpSize))) break;

    const frame = Buffer.from(buf.subarray(0, bmpSize));
    buf = buf.subarray(bmpSize);
    yield frame;
  }
}

async function main() {
  console.log(`Receiving from: ${rtmpUrl}`);
  console.log(`Expected message: ${expectedMessagePath}`);

  const { frames, cleanup } = grabFrames(rtmpUrl);

  const chunks = new Map();
  let totalChunks = null;
  let framesProcessed = 0;
  const startTime = Date.now();

  try {
    for await (const bmpBuffer of frames) {
      framesProcessed++;
      const width = bmpBuffer.readInt32LE(18);
      const height = Math.abs(bmpBuffer.readInt32LE(22));
      console.log(`Frame captured: ${width}x${height}, ${bmpBuffer.length} bytes`);

      try {
        const { chunkIndex, totalChunks: tc, data } = extractChunk(bmpBuffer);
        totalChunks = tc;
        if (!chunks.has(chunkIndex)) {
          chunks.set(chunkIndex, data);
          console.log(`  chunk ${chunkIndex + 1}/${tc}: ${data.length} bytes`);
        } else {
          console.log(`  chunk ${chunkIndex + 1}/${tc}: duplicate, skipping`);
        }

        if (chunks.size === totalChunks) {
          console.log("All chunks received");
          break;
        }
      } catch (err) {
        console.error(`  stego extraction failed: ${err.message}`);
      }
    }
  } finally {
    cleanup();
  }

  const elapsedMs = Date.now() - startTime;
  const elapsedSec = elapsedMs / 1000;

  if (totalChunks === null || chunks.size !== totalChunks) {
    const got = chunks.size;
    const expected = totalChunks ?? "?";
    console.error(`\nFailed: received ${got}/${expected} chunks (${elapsedSec.toFixed(1)}s, ${framesProcessed} frames)`);
    process.exit(1);
  }

  const payload = reassembleChunks(chunks);
  console.log(`\nExtracted stego payload: ${payload.length} bytes`);
  console.log(`  frames processed : ${framesProcessed} (${chunks.size} unique chunks)`);
  console.log(`  time             : ${elapsedSec.toFixed(1)}s`);
  console.log(`  throughput       : ${(payload.length / elapsedSec).toFixed(0)} bytes/s`);

  if (fs.existsSync(expectedMessagePath)) {
    const expected = fs.readFileSync(expectedMessagePath);
    if (payload.equals(expected)) {
      console.log("PASS: extracted payload matches the original message");
    } else {
      console.error("FAIL: payload does not match the original message");
      console.error(
        `  expected ${expected.length} bytes, got ${payload.length} bytes`
      );
      process.exit(1);
    }
  } else {
    console.log("(no reference message file to compare against)");
    const text = payload.toString("utf8");
    const isPrintable = /^[\x20-\x7e\r\n\t]*$/.test(text);
    if (isPrintable && text.length > 0) {
      console.log("Payload text:", text);
    } else {
      console.log("Payload (hex):", payload.toString("hex").slice(0, 80));
    }
  }
}

main().catch((err) => {
  console.error("Receive failed:", err.message);
  process.exit(1);
});
