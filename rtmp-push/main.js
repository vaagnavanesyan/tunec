const { FlvReader } = require("./flv-reader");
const { RtmpClient } = require("./rtmp-client");
const { createPipeline, tapLog } = require("./transforms");

const serverUrl = "rtmp://rtmp-lb-a.ntv.rutube.ru/live_push";
const streamKey =
  "1f2755edf3b021341ba36683641f7e9a?sinfo=xPRd97SOxYVNaC1NRPJ4tBK2XXPZYAQ";
const rtmpUrl = `${serverUrl}/${streamKey}`;

const inputSource = "input.flv";

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

const transform = createPipeline(
  tapLog("SEND")
  // Add transforms here, for example:
  // timeScale(1.0),
  // stripAudio(),
  // mapData((buf, tag) => { /* modify bytes */ return buf; }),
);

async function main() {
  const { host, port, app, streamPath, tcUrl } = parseRtmpUrl(rtmpUrl);
  console.log(`Connecting to ${host}:${port}, app=${app}`);

  const client = new RtmpClient();

  client.on("error", (err) => console.error("RTMP error:", err.message));
  client.on("close", () => console.log("Connection closed"));
  client.on("status", (args) => console.log("Status:", JSON.stringify(args)));

  await client.connect(host, port, app, tcUrl);
  console.log("Connected, creating stream...");

  await client.createStream();
  console.log(`Stream created (id=${client.streamId}), publishing...`);

  client.publish(streamPath);

  // Small delay to let the server process the publish command
  await sleep(100);

  const flv = new FlvReader(inputSource);
  const header = flv.open();
  console.log(
    `FLV: v${header.version}, audio=${header.hasAudio}, video=${header.hasVideo}`
  );

  const startTime = Date.now();
  let tagCount = 0;

  for (const tag of flv.tags()) {
    const transformed = transform(tag);
    if (!transformed) continue;

    // Real-time pacing: wait until the tag's timestamp
    const elapsed = Date.now() - startTime;
    const delay = transformed.timestamp - elapsed;
    if (delay > 0) await sleep(delay);

    client.sendTag(transformed);
    tagCount++;
  }

  flv.close();
  console.log(`Done. Sent ${tagCount} tags.`);

  await sleep(1000);
  client.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
