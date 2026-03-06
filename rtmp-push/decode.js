const fs = require("fs");
const { spawn } = require("child_process");
const { extractMessage } = require("./stego");

const DEFAULT_URL =
  "https://bl.rutube.ru/livestream/64e27a22cf18d510494937bedcbaee2a/index.m3u8?s=J_tvCKzuzMfQi9z5fDuI3Q&e=1772536256&scheme=https";

async function grabFrame(source) {
  const isFile = fs.existsSync(source) && !source.startsWith("http");

  if (isFile && source.endsWith(".bmp")) {
    console.log(`Reading local BMP: ${source}`);
    return fs.readFileSync(source);
  }

  console.log(`Grabbing frame from: ${source}`);

  const args = [
    "-loglevel",
    "warning",
    "-rw_timeout",
    "15000000",
    "-i",
    source,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-c:v",
    "bmp",
    "pipe:1",
  ];

  const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  return new Promise((resolve, reject) => {
    const killTimer = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      reject(new Error("Timeout: ffmpeg did not produce a frame in 120s"));
    }, 120_000);

    const stdoutChunks = [];
    let totalBytes = 0;
    let expectedSize = null;
    let resolved = false;

    ffmpeg.stdout.on("data", (chunk) => {
      if (resolved) return;
      stdoutChunks.push(chunk);
      totalBytes += chunk.length;

      if (expectedSize === null && totalBytes >= 6) {
        const buf = Buffer.concat(stdoutChunks);
        if (buf[0] === 0x42 && buf[1] === 0x4d) {
          expectedSize = buf.readUInt32LE(2);
          console.log(
            `BMP header received, expecting ${expectedSize} bytes...`
          );
        }
      }

      if (expectedSize !== null && totalBytes >= expectedSize) {
        resolved = true;
        clearTimeout(killTimer);
        ffmpeg.kill();
        const bmp = Buffer.concat(stdoutChunks).subarray(0, expectedSize);
        console.log(`Captured frame: ${bmp.length} bytes`);
        resolve(bmp);
      }
    });

    const stderrChunks = [];
    ffmpeg.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
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

    ffmpeg.on("error", (err) => {
      if (resolved) return;
      clearTimeout(killTimer);
      if (err.code === "ENOENT") {
        reject(new Error("ffmpeg not found. Install ffmpeg first."));
      } else {
        reject(err);
      }
    });

    ffmpeg.on("close", (code) => {
      if (resolved) return;
      clearTimeout(killTimer);
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      const lastLines = stderr.split("\n").slice(-10).join("\n");
      reject(
        new Error(
          `ffmpeg exited with code ${code} before producing a frame:\n${lastLines}`
        )
      );
    });
  });
}

async function main() {
  const source = process.argv[2] || DEFAULT_URL;

  const bmpBuffer = await grabFrame(source);

  const width = bmpBuffer.readInt32LE(18);
  const height = Math.abs(bmpBuffer.readInt32LE(22));
  console.log(`Frame dimensions: ${width}x${height}`);

  const payload = extractMessage(bmpBuffer);

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

main().catch((err) => {
  console.error("Decode failed:", err.message);
  process.exit(1);
});
