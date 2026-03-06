const { generateTags } = require("./image-source");
const { RtmpClient } = require("./rtmp-client");

const serverUrl = "rtmp://rtmp-lb-a.dth.rutube.ru/live_push";
const streamKey =
  "64e27a22cf18d510494937bedcbaee2a?sinfo=MKnxLetajRLO5TzvXQPwfz4AwKdAXda";
const rtmpUrl = `${serverUrl}/${streamKey}`;

const inputSource = "input.bmp";

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

  const startTime = Date.now();
  let tagCount = 0;

  for await (const tag of generateTags(inputSource, {
    fps: 1,
    messagePath: "message.bin",
  })) {
    const elapsed = Date.now() - startTime;
    const delay = tag.timestamp - elapsed;
    if (delay > 0) await sleep(delay);

    client.sendTag(tag);
    tagCount++;
  }

  console.log(`Done. Sent ${tagCount} tags.`);
  await sleep(1000);
  client.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
