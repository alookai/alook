#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : Number(args[index + 1]);
};
const businessPort = valueAfter("--port");
const inspectorPort = valueAfter("--inspector-port");
if (!businessPort || !process.env.ALOOK_APP_TEST_SPAWN_LOG) throw new Error("fake service is missing ports or spawn log");
appendFileSync(process.env.ALOOK_APP_TEST_SPAWN_LOG, `${process.pid} ${args.join(" ")}\n`);

const http = createHttpServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"ok":true}\n');
});
const inspector = inspectorPort ? createTcpServer(() => {}) : undefined;
await new Promise((resolve) => setTimeout(resolve, 300));
await new Promise((resolve, reject) => {
  http.once("error", reject);
  http.listen(businessPort, "127.0.0.1", resolve);
});
if (inspector) {
  await new Promise((resolve, reject) => {
    inspector.once("error", reject);
    inspector.listen(inspectorPort, "127.0.0.1", resolve);
  });
}

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  http.close(() => {
    if (inspector) inspector.close(() => process.exit(0));
    else process.exit(0);
  });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
