const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { resolveFFmpeg, hasNativeStego } = require("./image-source");

let stegoJs = null;
try {
  stegoJs = require("./stego");
} catch (_) {}

const DEFAULT_URL = "rtmp://localhost:1935/live/test";

const rtmpUrl = process.argv[2] || process.env.RTMP_URL || DEFAULT_URL;
const expectedMessagePath = process.argv[3] || "message.bin";

// --- Native stegoextract mode ---

async function receiveNative(
  source,
  { timeoutMs = 600_000, qstep = 0, bpp = 8, reps = 1, rsNsym = 0 } = {}
) {
  const ffmpegBin = resolveFFmpeg();
  const tmpFile = path.join(
    os.tmpdir(),
    `stego_recv_${process.pid}_${Date.now()}.bin`
  );

  const vfArgs = `stegoextract=out=${tmpFile}:qstep=${qstep}:bpp=${bpp}:reps=${reps}:rs=${rsNsym}`;

  console.log(`Native extraction from: ${source}`);

  const args = [
    "-loglevel",
    "info",
    "-rw_timeout",
    "15000000",
    "-analyzeduration",
    "0",
    "-probesize",
    "32",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-i",
    source,
    "-vf",
    vfArgs,
    "-f",
    "null",
    "-",
  ];

  const ffmpeg = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });

  let killed = false;
  const kill = () => {
    if (!killed) {
      killed = true;
      ffmpeg.kill();
    }
  };
  const killTimer = setTimeout(kill, timeoutMs);

  const startTime = Date.now();
  let framesProcessed = 0;

  ffmpeg.stderr.on("data", (chunk) => {
    const lines = chunk.toString().trim().split("\n");
    for (const line of lines) {
      if (line.includes("frame=")) {
        const m = line.match(/frame=\s*(\d+)/);
        if (m) framesProcessed = parseInt(m[1], 10);
      }
      if (
        line.includes("stego") ||
        line.includes("chunk") ||
        line.includes("Wrote") ||
        line.includes("All")
      )
        process.stderr.write(`  [ffmpeg] ${line}\n`);
      if (line.includes("All") && line.includes("chunks received")) {
        setTimeout(kill, 500);
      }
    }
  });

  const code = await new Promise((resolve) => {
    ffmpeg.on("close", (c) => {
      clearTimeout(killTimer);
      resolve(c);
    });
    ffmpeg.on("error", () => {
      clearTimeout(killTimer);
      resolve(1);
    });
  });

  const elapsedMs = Date.now() - startTime;
  const elapsedSec = elapsedMs / 1000;

  if (!fs.existsSync(tmpFile)) {
    console.error(
      `\nFailed: no output (${elapsedSec.toFixed(
        1
      )}s, ~${framesProcessed} frames, exit=${code})`
    );
    process.exit(1);
  }

  const payload = fs.readFileSync(tmpFile);
  fs.unlinkSync(tmpFile);

  console.log(`\nExtracted stego payload: ${payload.length} bytes`);
  console.log(`  frames processed : ~${framesProcessed}`);
  console.log(`  time             : ${elapsedSec.toFixed(1)}s`);
  console.log(
    `  throughput       : ${(payload.length / elapsedSec / 1024 / 1024).toFixed(
      1
    )} MB/s`
  );

  return payload;
}

// --- JS fallback mode ---

function grabFrames(source, { timeoutMs = 600_000 } = {}) {
  console.log(`Grabbing frames from: ${source}`);

  const args = [
    "-loglevel",
    "warning",
    "-rw_timeout",
    "15000000",
    "-analyzeduration",
    "0",
    "-probesize",
    "32",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-i",
    source,
    "-f",
    "image2pipe",
    "-c:v",
    "bmp",
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

  const killTimer = setTimeout(kill, timeoutMs);
  ffmpeg.stderr.on("data", () => {});

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
    exitPromise: new Promise((r) => ffmpeg.on("close", r)),
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
      await new Promise((resolve) => {
        waitResolve = resolve;
      });
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

async function receiveFallback(source) {
  if (!stegoJs)
    throw new Error("stego.js not available and native ffmpeg not found");

  const { frames, cleanup } = grabFrames(source);

  const chunks = new Map();
  let totalChunks = null;
  let framesProcessed = 0;
  const startTime = Date.now();

  try {
    for await (const bmpBuffer of frames) {
      framesProcessed++;
      const width = bmpBuffer.readInt32LE(18);
      const height = Math.abs(bmpBuffer.readInt32LE(22));
      console.log(
        `Frame captured: ${width}x${height}, ${bmpBuffer.length} bytes`
      );

      try {
        const {
          chunkIndex,
          totalChunks: tc,
          data,
        } = stegoJs.extractChunk(bmpBuffer);
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
    console.error(
      `\nFailed: received ${got}/${expected} chunks (${elapsedSec.toFixed(
        1
      )}s, ${framesProcessed} frames)`
    );
    process.exit(1);
  }

  const payload = stegoJs.reassembleChunks(chunks);
  console.log(`\nExtracted stego payload: ${payload.length} bytes`);
  console.log(
    `  frames processed : ${framesProcessed} (${chunks.size} unique chunks)`
  );
  console.log(`  time             : ${elapsedSec.toFixed(1)}s`);
  console.log(
    `  throughput       : ${(payload.length / elapsedSec / 1024 / 1024).toFixed(
      1
    )} MB/s`
  );

  return payload;
}

// --- Main ---

async function main() {
  const native = hasNativeStego();
  console.log(`Receiving from: ${rtmpUrl}`);
  console.log(`Expected message: ${expectedMessagePath}`);
  console.log(`Mode: ${native ? "native stegoextract" : "JS fallback"}`);

  const payload = native
    ? await receiveNative(rtmpUrl)
    : await receiveFallback(rtmpUrl);

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
