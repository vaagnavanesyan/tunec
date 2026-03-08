const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { resolveFFmpeg, hasNativeStego } = require("./image-source");

let stegoJs = null;
try { stegoJs = require("./stego"); } catch (_) {}

const DEFAULT_URL =
  "https://bl.rutube.ru/livestream/64e27a22cf18d510494937bedcbaee2a/index.m3u8?s=J_tvCKzuzMfQi9z5fDuI3Q&e=1772536256&scheme=https";

// --- Native stegoextract mode ---

async function decodeNative(source, { maxFrames = 256, timeoutMs = 120_000, qstep = 0, bpp = 8, reps = 1, rsNsym = 0 } = {}) {
  const ffmpegBin = resolveFFmpeg();
  const tmpFile = path.join(os.tmpdir(), `stego_extract_${process.pid}_${Date.now()}.bin`);

  const vfArgs = `stegoextract=out=${tmpFile}:qstep=${qstep}:bpp=${bpp}:reps=${reps}:rs=${rsNsym}`;

  const isFile = fs.existsSync(source) && !source.startsWith("http");
  const inputArgs = isFile && source.endsWith(".bmp")
    ? ["-f", "image2", "-i", source]
    : ["-rw_timeout", "15000000", "-i", source, "-frames:v", String(maxFrames)];

  console.log(`Native extraction from: ${source}`);

  const args = [
    "-loglevel", "info",
    ...inputArgs,
    "-vf", vfArgs,
    "-f", "null", "-",
  ];

  const ffmpeg = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });

  const killTimer = setTimeout(() => ffmpeg.kill("SIGKILL"), timeoutMs);

  ffmpeg.stderr.on("data", (chunk) => {
    const lines = chunk.toString().trim().split("\n");
    for (const line of lines) {
      if (line.includes("stego") || line.includes("chunk") || line.includes("Wrote"))
        process.stderr.write(`  [ffmpeg] ${line}\n`);
    }
  });

  const code = await new Promise((resolve) => {
    ffmpeg.on("close", (c) => { clearTimeout(killTimer); resolve(c); });
    ffmpeg.on("error", () => { clearTimeout(killTimer); resolve(1); });
  });

  if (code !== 0) {
    throw new Error(`ffmpeg exited with code ${code}`);
  }

  if (!fs.existsSync(tmpFile)) {
    throw new Error("stegoextract produced no output file");
  }

  const payload = fs.readFileSync(tmpFile);
  fs.unlinkSync(tmpFile);
  return payload;
}

// --- JS fallback mode (BMP frame extraction) ---

async function* grabFrames(source, { maxFrames = 256, timeoutMs = 120_000 } = {}) {
  const isFile = fs.existsSync(source) && !source.startsWith("http");

  if (isFile && source.endsWith(".bmp")) {
    console.log(`Reading local BMP: ${source}`);
    yield fs.readFileSync(source);
    return;
  }

  console.log(`Grabbing frames from: ${source}`);

  const args = [
    "-loglevel", "warning",
    "-rw_timeout", "15000000",
    "-i", source,
    "-frames:v", String(maxFrames),
    "-f", "image2pipe",
    "-c:v", "bmp",
    "pipe:1",
  ];

  const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  const killTimer = setTimeout(() => {
    ffmpeg.kill("SIGKILL");
  }, timeoutMs);

  ffmpeg.stderr.on("data", (chunk) => {
    const lines = chunk.toString().trim().split("\n");
    for (const line of lines) {
      if (
        line.includes("Opening") ||
        line.includes("Stream #") ||
        line.includes("Stream mapping")
      ) {
        process.stderr.write(`  [ffmpeg] ${line}\n`);
      }
    }
  });

  let killed = false;
  const kill = () => {
    if (!killed) {
      killed = true;
      clearTimeout(killTimer);
      ffmpeg.kill();
    }
  };

  ffmpeg.on("error", (err) => {
    clearTimeout(killTimer);
    if (err.code === "ENOENT") {
      throw new Error("ffmpeg not found. Install ffmpeg first.");
    }
    throw err;
  });

  try {
    yield* parseBmpStream(ffmpeg.stdout);
  } finally {
    kill();
  }
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

async function decodeFallback(source) {
  if (!stegoJs) throw new Error("stego.js not available and native ffmpeg not found");

  const chunks = new Map();
  let totalChunks = null;

  for await (const bmpBuffer of grabFrames(source)) {
    const width = bmpBuffer.readInt32LE(18);
    const height = Math.abs(bmpBuffer.readInt32LE(22));
    console.log(`Frame: ${width}x${height}, ${bmpBuffer.length} bytes`);

    try {
      const { chunkIndex, totalChunks: tc, data } = stegoJs.extractChunk(bmpBuffer);
      totalChunks = tc;
      if (!chunks.has(chunkIndex)) {
        chunks.set(chunkIndex, data);
        console.log(`  chunk ${chunkIndex + 1}/${tc}: ${data.length} bytes`);
      } else {
        console.log(`  chunk ${chunkIndex + 1}/${tc}: duplicate, skipping`);
      }

      if (chunks.size === totalChunks) break;
    } catch (err) {
      console.error(`  stego extraction failed: ${err.message}`);
    }
  }

  if (totalChunks === null || chunks.size !== totalChunks) {
    const got = chunks.size;
    const expected = totalChunks ?? "?";
    throw new Error(`Incomplete: received ${got}/${expected} chunks`);
  }

  return stegoJs.reassembleChunks(chunks);
}

// --- Main ---

function printPayload(payload) {
  console.log(`\nDecoded message (${payload.length} bytes):`);

  const text = payload.toString("utf8");
  const isPrintable = /^[\x20-\x7e\r\n\t]*$/.test(text);

  if (isPrintable && text.length > 0) {
    console.log(text);
  } else {
    console.log("(binary payload, hex dump):");
    for (let i = 0; i < payload.length; i += 16) {
      const slice = payload.subarray(i, Math.min(i + 16, payload.length));
      const hex = Array.from(slice)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      const ascii = Array.from(slice)
        .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
        .join("");
      console.log(
        `  ${i.toString(16).padStart(6, "0")}  ${hex.padEnd(47)}  ${ascii}`
      );
    }
  }
}

async function main() {
  const source = process.argv[2] || DEFAULT_URL;
  const native = hasNativeStego();

  console.log(`Mode: ${native ? "native stegoextract" : "JS fallback"}`);

  const payload = native
    ? await decodeNative(source)
    : await decodeFallback(source);

  printPayload(payload);
}

main().catch((err) => {
  console.error("Decode failed:", err.message);
  process.exit(1);
});
