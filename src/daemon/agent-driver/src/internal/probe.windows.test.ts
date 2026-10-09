import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentDriverSdk } from "../index.js";
import { isAlive, killProcessTree, spawnAgentProcess } from "./killTree.js";
import { probeCliRuntime, probeCommandOutput, resolveCommandOnPath, resolveSpawnSpec } from "./probe.js";

const roots: string[] = [];
const children: ChildProcess[] = [];

function setPrefix(prefix: string) {
  const bin = process.platform === "win32" ? prefix : join(prefix, "bin");
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
  vi.stubEnv("CODEX_HOME", join(prefix, "codex-home"));
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
  return child;
}

function waitForLine(child: ChildProcess, matches: (line: string) => boolean): Promise<string> {
  const lines = createInterface({ input: child.stdout! });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("runtime output timed out")), 20_000);
    const onExit = () => finish(new Error("runtime exited before readiness"));
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
    for (const binary of ["codex", "opencode"]) {
      writeFileSync(join(prefix, binary), "#!/bin/sh\nexit 1\n");
      writeFileSync(join(prefix, `${binary}.ps1`), "exit 1\n");
      writeFileSync(join(prefix, `${binary}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0fixture.cjs" %*\r\n`);
      expect(resolveCommandOnPath(binary)).toBe(join(prefix, `${binary}.cmd`));
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
describe.skipIf(!nativePrefix)("real npm providers from an isolated prefix", () => {
  it("probes Codex and OpenCode and starts their native servers without credentials", async () => {
    setPrefix(nativePrefix!);
    console.log(JSON.stringify({ os: release(), node: process.version, nodePath: process.execPath }));
    const sdk = createAgentDriverSdk();
    for (const backend of ["codex", "opencode"] as const) {
      expect((await sdk.probe({ backend })).status).toBe("healthy");
    }
    const codex = launch("codex", ["app-server", "--listen", "stdio://"]);
    const initialized = waitForLine(codex, line => {
      try { return JSON.parse(line).id === 1; } catch { return false; }
    });
    codex.stdin!.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "alook-windows-qa", version: "1.0.0" } } }) + "\n");
    expect(JSON.parse(await initialized)).toHaveProperty("result");
    codex.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
    await stop(codex);

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
  }, 90_000);
});
