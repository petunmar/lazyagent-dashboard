import { spawn } from "node:child_process";
import http from "node:http";

const host = process.env.EXTENSION_HOST || "127.0.0.1";
const backendPort = Number(process.env.EXTENSION_PORT || 5174);
const backendUrl = `http://${host}:${backendPort}`;

const children = [];

if (await backendIsHealthy()) {
  console.log(`lazyagent-extension backend already running on ${backendUrl}; reusing it`);
} else {
  children.push(spawn(process.execPath, ["src/backend/server.js"], { stdio: "inherit", env: process.env }));
}

children.push(spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"], { stdio: "inherit", env: process.env }));

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250).unref();
}

for (const child of children) {
  child.on("exit", code => {
    if (!shuttingDown && code) shutdown(code);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function backendIsHealthy() {
  return new Promise(resolve => {
    const req = http.get(`${backendUrl}/health`, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}
