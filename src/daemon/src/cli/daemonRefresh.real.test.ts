import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { readDaemonVersion } from "../version";

it.runIf(process.platform !== "win32").each([100, 1000])("refreshes a real CLI runner and rolls back after a %dms startup receipt failure", async (receiptTimeoutMs) => {
  const root = mkdtempSync(join(tmpdir(), "alook-refresh-real-"));
  const machineId = "cm_refresh_real_1234";
  const machineKey = "cmk_SYNTHETIC_REFRESH_TEST_ONLY";
  const baseDir = join(root, "data");
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const cli = join(packageRoot, "src/cli/index.ts");
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const shell = join(root, "shell");
  const exportsFile = join(root, "exports");
  const observationFile = join(root, "probe-observations");
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(baseDir, "daemons"), { recursive: true });
  writeFileSync(shell, `#!/bin/sh\n. '${exportsFile}'\nprintf '__ALOOK_ENV_V1__\\000'\nexec /usr/bin/env -0\n`, { mode: 0o700 });
  const exportValue = (value: string) => writeFileSync(exportsFile, `export ALOOK_SYNTHETIC_REFRESH='${value}'\nexport PATH='${bin}:/usr/bin:/bin'\n`);
  exportValue("v1");
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nprintf '%s|%s\\n' "$ALOOK_SYNTHETIC_REFRESH" "$ALOOK_OLD_ONLY" >> '${observationFile}'\necho 'codex-cli 0.70.0'\n`, { mode: 0o700 });
  const wss = new WebSocketServer({ noServer: true });
  const sockets: WebSocket[] = [];
  const ready: Array<{ socket: WebSocket; frame: { daemonVersion: string; capabilities: string[] } }> = [];
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url?.includes("/bots") ? { bots: [] } : { attempted: 0 }));
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.authorization !== `Bearer ${machineKey}`) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.push(ws);
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "ready") ready.push({ socket: ws, frame });
      });
    });
  });
  const cliRun = async (args: string[]) => {
    const child = spawn(process.execPath, ["--import", loader, cli, "daemon", ...args], {
      cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
        HOME: root, SHELL: shell, PATH: `${bin}:/usr/bin:/bin`, ALOOK_SYNTHETIC_REFRESH: "v1", ALOOK_OLD_ONLY: "stale", ALOOK_LOG_LEVEL: "warn" },
    });
    let output = "";
    child.stdout.on("data", (data) => { output += String(data); });
    child.stderr.on("data", (data) => { output += String(data); });
    return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, output }));
    });
  };
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 20000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("isolated refresh fixture timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const pidfile = join(baseDir, "daemons", machineId, "daemon.pid");
  const recordPath = join(baseDir, "daemons", `${machineId}.credential.json`);
  const owner = () => JSON.parse(readFileSync(pidfile, "utf8")) as { pid: number; machineId: string };
  let started = false;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    writeFileSync(recordPath, JSON.stringify({ schemaVersion: 1, credential: machineKey, machineId,
      serverUrl: origin, wsUrl: origin.replace("http:", "ws:"), daemonVersion: readDaemonVersion() }), { mode: 0o600 });
    const result = await cliRun(["start", "--machine-key", machineKey, "--server-url", origin,
      "--ws-url", origin.replace("http:", "ws:"), "--base-dir", baseDir]);
    expect(result.code, result.output).toBe(0);
    started = true;
    await waitFor(() => ready.length > 0);
    const first = owner();
    const originalRecord = readFileSync(recordPath, "utf8");
    expect(ready[0].frame.capabilities).toContain("machineRefresh");
    exportValue("v2");
    const command = JSON.stringify({ type: "machine:refresh" });
    sockets[0].send(command);
    sockets[0].send(command);
    await waitFor(() => sockets.length === 2 && ready.some((entry) => entry.socket === sockets[1]));
    const second = owner();
    expect(second.machineId).toBe(machineId);
    expect(second.pid).not.toBe(first.pid);
    expect(sockets).toHaveLength(2);
    expect(ready.find((entry) => entry.socket === sockets[1])!.frame.daemonVersion).toBe(ready[0].frame.daemonVersion);
    expect(readFileSync(recordPath, "utf8")).toBe(originalRecord);
    expect(readFileSync(observationFile, "utf8").split("\n")).toContain("v2|");
    expect(readFileSync(observationFile, "utf8").split("\n")).toContain("v1|stale");
    expect(requests.some((url) => /activate|pair|identity/.test(url))).toBe(false);
    writeFileSync(shell, "#!/bin/sh\necho PRIVATE_ENVIRONMENT_VALUE >&2\nexit 1\n", { mode: 0o700 });
    sockets[1].send(command);
    await waitFor(() => readFileSync(join(baseDir, "daemons", machineId, "daemon.log"), "utf8").includes("machine refresh failed"));
    expect(owner().pid).toBe(second.pid);
    expect(sockets[1].readyState).toBe(WebSocket.OPEN);
    expect(readFileSync(join(baseDir, "daemons", machineId, "daemon.log"), "utf8")).not.toContain("PRIVATE_ENVIRONMENT_VALUE");
    writeFileSync(shell, `#!/bin/sh\n. '${exportsFile}'\nprintf '__ALOOK_ENV_V1__\\000'\nexec /usr/bin/env -0\n`, { mode: 0o700 });
    exportValue("v3");
    writeFileSync(exportsFile, readFileSync(exportsFile, "utf8") + `export ALOOK_DAEMON_TEST_SKIP_READY=1\nexport ALOOK_DAEMON_TEST_RECEIPT_TIMEOUT_MS=${receiptTimeoutMs}\n`);
    const probeOffset = readFileSync(observationFile, "utf8").trim().split("\n").length;
    sockets[1].send(command);
    await waitFor(() => {
      if (existsSync(join(baseDir, "daemons", machineId, "daemon.replace.lock")) || !existsSync(pidfile)) return false;
      const probes = readFileSync(observationFile, "utf8").trim().split("\n").slice(probeOffset);
      return owner().pid !== second.pid && probes.includes("v3|") && probes.at(-1) === "v2|"
        && ready.some((entry) => entry.socket !== sockets[1] && entry.socket.readyState === WebSocket.OPEN);
    });
    expect(owner().pid).not.toBe(second.pid);
    expect(owner().machineId).toBe(machineId);
    expect(readFileSync(recordPath, "utf8")).toBe(originalRecord);
    expect(readFileSync(observationFile, "utf8").trim().split("\n").at(-1)).toBe("v2|");

  } finally {
    if (started && existsSync(pidfile)) await cliRun(["stop", machineId, "--base-dir", baseDir]);
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
