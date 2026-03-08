const NodeMediaServer = require("node-media-server");

const config = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60,
  },
  record: {
    path: "./html/record",
  },
  http: {
    port: 8000,
    allow_origin: "*",
  },
};

const nms = new NodeMediaServer(config);

nms.on("preConnect", (_id, args) => {
  console.log("[connect]", args);
});

nms.on("prePublish", (_id, streamPath) => {
  console.log("[publish]", streamPath);
});

nms.on("prePlay", (_id, streamPath) => {
  console.log("[play]", streamPath);
});

nms.on("donePublish", (_id, streamPath) => {
  console.log("[unpublish]", streamPath);
});

nms.run();

console.log("RTMP server listening on rtmp://localhost:1935");
console.log("HTTP-FLV available at http://localhost:8000");
