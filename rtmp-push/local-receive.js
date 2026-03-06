const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { extractMessage } = require("./stego");

const DEFAULT_URL = "rtmp://localhost:1935/live/test";

const rtmpUrl = process.argv[2] || process.env.RTMP_URL || DEFAULT_URL;
const expectedMessagePath = process.argv[3] || "message.bin";

function grabFrame(source, timeoutMs = 30_000) {
  console.log(`Grabbing frame from: ${source}`);

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
      reject(new Error(`Timeout: no frame received in ${timeoutMs / 1000}s`));
    }, timeoutMs);

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
    ffmpeg.stderr.on("data", (chunk) => stderrChunks.push(chunk));

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
  console.log(`Receiving from: ${rtmpUrl}`);
  console.log(`Expected message: ${expectedMessagePath}`);

  const bmpBuffer = await grabFrame(rtmpUrl);

  const width = bmpBuffer.readInt32LE(18);
  const height = Math.abs(bmpBuffer.readInt32LE(22));
  console.log(`Frame dimensions: ${width}x${height}`);

  let payload;
  try {
    payload = extractMessage(bmpBuffer);
    console.log(`\nExtracted stego payload: ${payload.length} bytes`);
  } catch (err) {
    console.error(`\nStego extraction failed: ${err.message}`);
    process.exit(1);
  }

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
