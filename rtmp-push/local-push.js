const fs = require("fs");
const { generateTags } = require("./image-source");
const { RtmpClient } = require("./rtmp-client");

const DEFAULT_URL = "rtmp://localhost:1935/live/test";

const rtmpUrl = process.argv[2] || process.env.RTMP_URL || DEFAULT_URL;
const inputSource = process.argv[3] || "input.bmp";
const messagePath = process.argv[4] || "message.bin";

function parseRtmpUrl(url) {
  const match = url.match(/^rtmp:\/\/([^/:]+)(?::(\d+))?\/([\w_-]+)\/(.*)/);
  if (!match) throw new Error(`Invalid RTMP URL: ${url}`);
  return {
    host: match[1],
    port: parseInt(match[2] || "1935", 10),
    app: match[3],
    streamPath: match[4],
    tcUrl: `rtmp://${match[1]}:${match[2] || "1935"}/${match[3]}`,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { host, port, app, streamPath, tcUrl } = parseRtmpUrl(rtmpUrl);
  console.log(`Pushing to ${rtmpUrl}`);
  console.log(`  host=${host} port=${port} app=${app} stream=${streamPath}`);
  console.log(`  input=${inputSource} message=${messagePath}`);

  const client = new RtmpClient();

  client.on("error", (err) => console.error("RTMP error:", err.message));
  client.on("close", () => console.log("Connection closed"));
  client.on("status", (args) => console.log("Status:", JSON.stringify(args)));

  await client.connect(host, port, app, tcUrl);
  console.log("Connected, creating stream...");

  await client.createStream();
  console.log(`Stream created (id=${client.streamId}), publishing...`);

  client.publish(streamPath);
  await sleep(100);

  const msgSize = fs.statSync(messagePath).size;
  const startTime = Date.now();
  let tagCount = 0;
  let videoBytes = 0;

  for await (const tag of generateTags(inputSource, {
    fps: 10,
    messagePath,
    holdSeconds: 10,
  })) {
    const elapsed = Date.now() - startTime;
    const delay = tag.timestamp - elapsed;
    if (delay > 0) await sleep(delay);

    client.sendTag(tag);
    tagCount++;
    videoBytes += tag.data.length;
  }

  const elapsedMs = Date.now() - startTime;
  const elapsedSec = elapsedMs / 1000;
  console.log(`\nDone. Sent ${tagCount} tags in ${elapsedSec.toFixed(1)}s`);
  console.log(`  hidden payload : ${msgSize} bytes`);
  console.log(`  video sent     : ${(videoBytes / 1024).toFixed(1)} KB`);
  console.log(`  throughput     : ${(msgSize / elapsedSec).toFixed(0)} bytes/s (payload), ${(videoBytes / 1024 / elapsedSec).toFixed(1)} KB/s (video)`);
  await sleep(1000);
  client.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
