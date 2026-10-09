import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { execFileSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPiSdkModule } from "../adapters/pi/sessionDeps.js";
import { createAgentDriverSdk } from "../index.js";
import { scrubDriverErrorMessage } from "./errors.js";
import { isAlive, killProcessTree, spawnAgentProcess } from "./killTree.js";
import { probeCliRuntime, probeCommandOutput, probeCommandVersion, resolveCommandOnPath, resolveSpawnSpec } from "./probe.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const diagnostics = new Map<ChildProcess, { binary: string; stderr: string }>();

function setPrefix(prefix: string) {
  const bin = process.platform === "win32" ? prefix : join(prefix, "bin");
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
  mkdirSync(join(prefix, "codex-home"), { recursive: true });
  vi.stubEnv("CODEX_HOME", join(prefix, "codex-home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(prefix, "pi-home"));
  vi.stubEnv("GEMINI_HOME", join(prefix, "gemini-home"));
  vi.stubEnv("CURSOR_CONFIG_DIR", join(prefix, "cursor-home"));
  vi.stubEnv("GROK_DISABLE_AUTOUPDATER", "1");
  vi.stubEnv("HOME", prefix);
  vi.stubEnv("USERPROFILE", prefix);
  vi.stubEnv("XDG_CONFIG_HOME", join(prefix, "config"));
  vi.stubEnv("XDG_DATA_HOME", join(prefix, "data"));
}

function launch(binary: string, args: string[]) {
  const spec = resolveSpawnSpec(binary, args);
  const child = spawnAgentProcess(spec.command, spec.args, {
    cwd: process.cwd(), env: process.env, shell: spec.shell,
  });
  children.push(child);
  const trace = { binary, stderr: "" };
  diagnostics.set(child, trace);
  child.stderr?.on("data", chunk => { trace.stderr = (trace.stderr + String(chunk)).slice(-4096); });
  return child;
}

function waitForLine(child: ChildProcess, matches: (line: string) => boolean): Promise<string> {
  const lines = createInterface({ input: child.stdout! });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("runtime output timed out")), 20_000);
    const onExit = (code: number | null, signal: string | null) => {
      const trace = diagnostics.get(child);
      finish(new Error(`${trace?.binary} exited before readiness: code=${code}, signal=${signal}, stderr=${scrubDriverErrorMessage(trace?.stderr ?? "")}`));
    };
    function finish(error?: Error, line?: string) {
      clearTimeout(timer);
      lines.close();
      child.off("exit", onExit);
      child.off("error", finish);
      if (error) reject(error);
      else resolve(line!);
    }
    lines.on("line", (line) => { if (matches(line)) finish(undefined, line); });
    child.once("exit", onExit);
    child.once("error", finish);
  });
}

async function stop(child: ChildProcess) {
  const closed = once(child, "close");
  await killProcessTree(child.pid!, { graceMs: 300 });
  await closed;
  expect(isAlive(child.pid!)).toBe(false);
  children.splice(children.indexOf(child), 1);
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && isAlive(child.pid)) await killProcessTree(child.pid, { graceMs: 100 });
  }
  diagnostics.clear();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe.skipIf(process.platform !== "win32")("native Windows npm shim detection and launch", () => {
  it.each(["npm-prefix-", "npm prefix with spaces-"])("detects and launches npm shim triplets in %s", async (name) => {
    const prefix = mkdtempSync(join(tmpdir(), name));
    roots.push(prefix);
    setPrefix(prefix);
    writeFileSync(join(prefix, "fixture.cjs"), `
      if (process.argv.includes('--version')) console.log('1.2.3');
      else if (process.argv.includes('models')) console.log('fixture/model');
      else {
        console.log('ready:' + process.pid);
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => console.log('echo:' + line));
        setInterval(() => {}, 1000);
      }
    `);
    for (const binary of ["codex", "opencode", "claude", "cursor-agent", "grok", "pi"]) {
      writeFileSync(join(prefix, binary), "#!/bin/sh\nexit 1\n");
      writeFileSync(join(prefix, `${binary}.ps1`), "exit 1\n");
      writeFileSync(join(prefix, `${binary}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0fixture.cjs" %*\r\n`);
      const oldFirst = execFileSync("where", [binary], { encoding: "utf8" }).split(/\r?\n/)[0]!.trim();
      expect(probeCommandVersion(oldFirst).ok).toBe(false);
      expect(realpathSync(resolveCommandOnPath(binary)!)).toBe(realpathSync(join(prefix, `${binary}.cmd`)));
      expect(probeCliRuntime(binary)).toEqual({ status: "healthy", version: "1.2.3" });
      const catalog = probeCommandOutput(join(prefix, `${binary}.cmd`), ["models", "--pure"]);
      expect(catalog.ok).toBe(true);
      if (catalog.ok) expect(catalog.output.trim()).toBe("fixture/model");
      const child = launch(binary, ["persistent"]);
      const ready = await waitForLine(child, line => line.startsWith("ready:"));
      const runtimePid = Number(ready.slice("ready:".length));
      expect(isAlive(runtimePid)).toBe(true);
      const echo = waitForLine(child, line => line === "echo:hello");
      child.stdin!.write("hello\n");
      expect(await echo).toBe("echo:hello");
      await stop(child);
      expect(isAlive(runtimePid)).toBe(false);
    }
  });

  it("keeps missing and damaged npm entries unhealthy", () => {
    const prefix = mkdtempSync(join(tmpdir(), "npm-broken-"));
    roots.push(prefix);
    setPrefix(prefix);
    const binary = "alook-qa-missing-runtime";
    expect(probeCliRuntime(binary)).toEqual({ status: "unhealthy", lastError: "not_on_path" });
    writeFileSync(join(prefix, `${binary}.cmd`), "@exit /b 7\r\n");
    expect(probeCliRuntime(binary).status).toBe("unhealthy");
  });
});


const nativePrefix = process.env.ALOOK_NATIVE_NPM_PREFIX;
describe.skipIf(!nativePrefix)("real npm and native providers from an isolated prefix", () => {
  it.each(["codex", "opencode", "claude", "cursor", "pi", "antigravity"] as const)("detects the real %s install via its public SDK probe", async (backend) => {
    setPrefix(nativePrefix!);
    console.log(JSON.stringify({ backend, os: release(), node: process.version, nodePath: process.execPath }));
    const result = await createAgentDriverSdk().probe({ backend });
    console.log(JSON.stringify({ backend, status: result.status, version: result.status === "healthy" ? result.version : undefined,
      error: result.status === "unhealthy" ? result.error.code : undefined }));
    expect(result.status).toBe("healthy");
  });

  it("starts real Codex app-server and completes initialize", async () => {
    setPrefix(nativePrefix!);
    const codex = launch("codex", ["app-server", "--listen", "stdio://"]);
    const initialized = waitForLine(codex, line => {
      try { return JSON.parse(line).id === 1; } catch { return false; }
    });
    codex.stdin!.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "alook-windows-qa", version: "1.0.0" } } }) + "\n");
    expect(JSON.parse(await initialized)).toHaveProperty("result");
    codex.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
    await stop(codex);
  });

  it("starts real OpenCode serve and returns localhost health", async () => {
    setPrefix(nativePrefix!);
    const portFinder = createServer();
    portFinder.listen(0, "127.0.0.1");
    await once(portFinder, "listening");
    const port = (portFinder.address() as { port: number }).port;
    await new Promise<void>((resolve) => portFinder.close(() => resolve()));
    const opencode = launch("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)]);
    await waitForLine(opencode, line => line.includes(`127.0.0.1:${port}`));
    const health = await fetch(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(5000) });
    expect(health.ok).toBe(true);
    expect(await health.json()).toMatchObject({ healthy: true });
    await stop(opencode);
  });

  it("starts real Claude's stream-json control protocol", async () => {
    setPrefix(nativePrefix!);
    const claude = launch("claude", ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
    const initialized = waitForLine(claude, line => {
      try { return JSON.parse(line).type === "control_response"; } catch { return false; }
    });
    claude.stdin!.write(JSON.stringify({ type: "control_request", request_id: "alook-qa-init", request: { subtype: "initialize" } }) + "\n");
    expect(JSON.parse(await initialized)).toMatchObject({ type: "control_response", response: { subtype: "success" } });
    await stop(claude);
  });

  it.each([
    ["cursor-agent", ["acp"]],
    ["grok", ["agent", "--no-leader", "stdio"]],
    ["agy_acp_server.exe", []],
  ] as const)("initializes the real %s ACP process without a model request", async (binary, args) => {
    setPrefix(nativePrefix!);
    const child = launch(binary, [...args]);
    const initialized = waitForLine(child, line => {
      try { return JSON.parse(line).id === 1; } catch { return false; }
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "alook-windows-qa", version: "1.0.0" },
    } }) + "\n");
    expect(JSON.parse(await initialized)).toMatchObject({ result: { protocolVersion: 1 } });
    await stop(child);
  });

  it("classifies real Grok authentication separately from installation", async () => {
    setPrefix(nativePrefix!);
    expect(probeCliRuntime("grok").status).toBe("healthy");
    const probe = await createAgentDriverSdk().probe({ backend: "grok" });
    console.log(JSON.stringify({ backend: "grok", status: probe.status, error: probe.status === "unhealthy" ? probe.error.code : undefined }));
    if (probe.status === "unhealthy") expect(probe.error.code).toBe("grok_acp_authentication_failed");
  });

  it("imports the real Pi SDK and creates/disposes a persistent session without a model request", async () => {
    setPrefix(nativePrefix!);
    const piSdk = await loadPiSdkModule();
    const sessionManager = piSdk.SessionManager.create(nativePrefix!, join(nativePrefix!, "pi-sessions"));
    const { session } = await piSdk.createAgentSession({ cwd: nativePrefix!, agentDir: join(nativePrefix!, "pi-home"), sessionManager, tools: [] });
    const nativeSession = session as { sessionId: string; prompt: unknown; dispose(): void };
    expect(typeof nativeSession.sessionId).toBe("string");
    expect(typeof nativeSession.prompt).toBe("function");
    nativeSession.dispose();
  });
});
