const { spawn } = require("child_process");
const path = require("path");

const RTMP_URL = "rtmp://localhost:1935/live/test";
const SETTLE_MS = 2000;
const RECEIVE_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(script, args = []) {
  const label = path.basename(script, ".js");
  const child = spawn(process.execPath, [script, ...args], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (d) => {
    for (const line of d.toString().trimEnd().split("\n")) {
      console.log(`[${label}] ${line}`);
    }
  });

  child.stderr.on("data", (d) => {
    for (const line of d.toString().trimEnd().split("\n")) {
      console.error(`[${label}] ${line}`);
    }
  });

  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });

  return { child, done };
}

async function main() {
  console.log("=== Starting local RTMP server ===");
  const server = spawn(process.execPath, ["local-server.js"], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", (d) => {
    for (const line of d.toString().trimEnd().split("\n")) {
      console.log(`[server] ${line}`);
    }
  });
  server.stderr.on("data", (d) => {
    for (const line of d.toString().trimEnd().split("\n")) {
      console.error(`[server] ${line}`);
    }
  });

  let serverExited = false;
  server.on("close", (code) => {
    serverExited = true;
    if (code) console.error(`[server] exited with code ${code}`);
  });

  await sleep(SETTLE_MS);
  if (serverExited) {
    console.error("Server failed to start");
    process.exit(1);
  }

  try {
    console.log("\n=== Starting push ===");
    const push = run("local-push.js", [RTMP_URL]);

    await sleep(RECEIVE_DELAY_MS);

    console.log("\n=== Starting receive ===");
    const receiveCode = await run("local-receive.js", [RTMP_URL]).done;

    push.child.kill();
    const pushCode = await push.done;

    console.log("\n=== Results ===");
    console.log(`  push   : exit code ${pushCode ?? "killed"}`);
    console.log(`  receive: exit code ${receiveCode}`);

    if (receiveCode === 0) {
      console.log("\nLocal test PASSED");
    } else {
      console.log("\nLocal test FAILED");
    }

    process.exitCode = receiveCode;
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
