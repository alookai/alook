import { expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

it("remote Stop exits the real runner successfully and retains the credential for an explicit restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alook-machine-stop-"));
  const recordPath = join(dir, "credential.json");
  writeFileSync(recordPath, JSON.stringify({ machineId: "cm_stop_real", credential: "cmk_stop_real_fixture" }), { mode: 0o600 });
  const originalRecord = readFileSync(recordPath, "utf8");
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const runner = pathToFileURL(join(packageRoot, "src/cli/daemonRunner.ts")).href;
  const fixture = join(dir, "runner.mts");
  writeFileSync(fixture, `
import { runPreparedDaemon } from ${JSON.stringify(runner)};
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const baseDir=process.argv[2], origin=process.argv[3];
const record=JSON.parse(readFileSync(join(baseDir,"credential.json"),"utf8"));
const daemonDir=join(baseDir,"daemons",record.machineId);
mkdirSync(daemonDir,{recursive:true});
await runPreparedDaemon({
  machineId:record.machineId,machineKey:record.credential,serverUrl:origin,
  wsUrl:origin.replace("http:","ws:")+"/control",baseDir,daemonDir,
  statusFilePath:join(daemonDir,"status.json"),agentCliPath:undefined,
  runtimeReport:[],healthyRuntimeIds:[],hostname:"stop-fixture",platform:"test",arch:"test",
  osRelease:"test",daemonVersion:"0.1.57",ownerToken:"test-owner",startedAt:new Date().toISOString(),
},{foreground:false,onReady:()=>process.stdout.write("RUNNER_READY\\n"),
releaseOwnership:()=>appendFileSync(join(baseDir,"released"),"released\\n")});
`);
  const wss = new WebSocketServer({ noServer: true });
  const sockets: WebSocket[] = [];
  const ready: Array<{ socket: WebSocket; capabilities: string[] }> = [];
  const authenticated: boolean[] = [];
  const requests: string[] = [];
  const children: ChildProcess[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url?.includes("/bots") ? { bots: [] } : { attempted: 0 }));
  });
  server.on("upgrade", (request, socket, head) => {
    authenticated.push(request.headers.authorization === "Bearer cmk_stop_real_fixture");
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (socket: WebSocket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "ready" && !ready.some((entry) => entry.socket === socket)) ready.push({ socket, capabilities: frame.capabilities ?? [] });
    });
  });
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Stop fixture condition timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Stop fixture did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    for (let round = 0; round < 2; round++) {
      let runnerReady = false;
      const child = spawn(process.execPath, ["--import", loader, fixture, dir, origin], {
        cwd: packageRoot, env: { ...process.env, ALOOK_LOG_LEVEL: "error" }, stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      child.stdout?.on("data", (chunk) => { if (String(chunk).includes("RUNNER_READY")) runnerReady = true; });
      child.stderr?.resume();
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      await waitFor(() => runnerReady && ready.length > round);
      const connection = ready[round]!;
      expect(connection.capabilities).toContain("machine-stop-v1");
      connection.socket.send(JSON.stringify({ type: "machine:stop" }));
      await waitFor(() => child.exitCode !== null);
      expect(await exited).toBe(0);
      await waitFor(() => connection.socket.readyState === WebSocket.CLOSED);
      expect(readFileSync(recordPath, "utf8")).toBe(originalRecord);
      expect(readFileSync(join(dir, "released"), "utf8").trim().split("\n")).toHaveLength(round + 1);
      expect(sockets).toHaveLength(round + 1);
    }
    expect(authenticated).toEqual([true, true]);
    expect(requests.some((url) => /activate|pair|enroll-agent/.test(url))).toBe(false);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
    }
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);
