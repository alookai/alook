import { once } from "node:events";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPiSdkModule } from "../adapters/pi/sessionDeps.js";
import { PiDriver } from "../adapters/pi/index.js";
import { fakeLaunchContext } from "../testing/adapter-fixture.js";
import { createAgentDriverSdk } from "../index.js";
import { scrubDriverErrorMessage } from "./errors.js";
import { isAlive, killProcessTree, spawnAgentProcess } from "./killTree.js";
import { probeCliRuntime, probeCommandOutput, probeCommandVersion, resolveClaudeCommand, resolveCommandOnPath, resolveSpawnSpec } from "./probe.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const diagnostics = new Map<ChildProcess, { binary: string; stdout: string; stderr: string }>();
type InitPhase = { stage: string; pid: number; childPid?: number; clock: string; nanoseconds?: string; ticks?: string; frequency?: string; highResolution?: boolean };
type InitEvidence = { directory: string; record(event: string, detail?: Record<string, unknown>): void; collect(event: string, child: ChildProcess): void; deadlineSnapshot(child: ChildProcess): void; finished(): Promise<void> };
const initializationEvidence = new Map<ChildProcess, InitEvidence>();
const initStages = ["ps-enter", "add-type-ready", "native-created", "native-resumed", "runner-enter", "target-spawn"] as const;

function initializationTraceEnabled(binary: string, flag = process.env.ALOOK_WINDOWS_ACP_INITIALIZE_TRACE): boolean {
  return binary === "agy_acp_server.exe" && flag === "1";
}

function bindInputBytes(path: string) {
  try {
    const before = statSync(path);
    const bytes = readFileSync(path);
    const after = statSync(path);
    return { path, status: before.size === after.size && before.mtimeMs === after.mtimeMs ? "bound" : "changed-during-read",
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mtimeMs: after.mtimeMs };
  } catch (error) {
    return { path, status: "unavailable", code: error && typeof error === "object" && "code" in error ? String(error.code) : "read-failed" };
  }
}

function readInitPhase(directory: string, stage: string): InitPhase | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, stage + ".json"), "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    if (value.stage !== stage || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return;
    const phase: InitPhase = { stage, pid: value.pid as number, clock: String(value.clock) };
    if (["native-created", "native-resumed", "target-spawn"].includes(stage) && value.childPid === undefined) return;
    if (value.childPid !== undefined) {
      if (!Number.isSafeInteger(value.childPid) || (value.childPid as number) < (stage === "add-type-ready" ? 0 : 1)) return;
      phase.childPid = value.childPid as number;
    }
    if (value.clock === "node-hrtime" && typeof value.nanoseconds === "string" && /^\d+$/.test(value.nanoseconds)) phase.nanoseconds = value.nanoseconds;
    else if (value.clock === "windows-qpc-stopwatch" && typeof value.ticks === "string" && /^\d+$/.test(value.ticks)
      && typeof value.frequency === "string" && /^[1-9]\d*$/.test(value.frequency) && typeof value.highResolution === "boolean") {
      phase.ticks = value.ticks; phase.frequency = value.frequency; phase.highResolution = value.highResolution;
    } else return;
    return phase;
  } catch { return; }
}

function sameClockIntervalNs(from: InitPhase | undefined, to: InitPhase | undefined): string | null {
  if (!from || !to || from.pid !== to.pid || from.clock !== to.clock) return null;
  let delta: bigint;
  if (from.clock === "node-hrtime" && from.nanoseconds && to.nanoseconds) delta = BigInt(to.nanoseconds) - BigInt(from.nanoseconds);
  else if (from.clock === "windows-qpc-stopwatch" && from.highResolution && to.highResolution
    && from.frequency && from.frequency === to.frequency && from.ticks && to.ticks) {
    delta = (BigInt(to.ticks) - BigInt(from.ticks)) * 1_000_000_000n / BigInt(from.frequency);
  } else return null;
  return delta >= 0n ? delta.toString() : null;
}

function prepareInitEvidence(binary: string): InitEvidence | undefined {
  if (!initializationTraceEnabled(binary)) return;
  try {
    const evidenceRoot = join(process.env.RUNNER_TEMP ?? tmpdir(), "Alook runtime evidence");
    mkdirSync(evidenceRoot, { recursive: true });
    const directory = mkdtempSync(join(evidenceRoot, "antigravity-initialize-"));
    const executable = resolveSpawnSpec(binary, []).command;
    const zip = process.env.ALOOK_WINDOWS_ACP_ZIP ?? join(process.env.RUNNER_TEMP ?? tmpdir(), "agy-acp-server.zip");
    writeFileSync(join(directory, "inputs.json"), JSON.stringify({
      schema: 1, binary, zip: bindInputBytes(zip), executable: bindInputBytes(executable),
      node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch,
      checkout: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      clocks: { parent: "node-hrtime nanoseconds; epochMs is separate wall time", native: "windows-qpc-stopwatch ticks/frequency", crossClockCorrelation: "UNQUALIFIED; no cross-process/domain subtraction" },
    }, null, 2));
    let pending = Promise.resolve();
    let snapshotStarted = false;
    const record = (event: string, detail: Record<string, unknown> = {}) => {
      try {
        appendFileSync(join(directory, "parent-events.jsonl"), JSON.stringify({
          schema: 1, event, parentPid: process.pid, clock: "node-hrtime", unit: "ns",
          nanoseconds: process.hrtime.bigint().toString(), epochMs: Date.now(), ...detail,
        }) + "\n");
      } catch {}
    };
    const collect = (event: string, child: ChildProcess) => {
      try {
        const phases = Object.fromEntries(initStages.map(stage => [stage, readInitPhase(directory, stage)])) as Record<string, InitPhase | undefined>;
        const native = initStages.slice(0, 4).map(stage => phases[stage]);
        record(event, {
          supervisorPid: child.pid, runnerPid: phases["runner-enter"]?.pid ?? null, targetPid: phases["target-spawn"]?.childPid ?? null,
          missing: initStages.filter(stage => !phases[stage]), phases,
          associations: {
            supervisor: native.every(phase => !!phase && phase.pid === child.pid),
            createdRunner: !!phases["runner-enter"] && phases["native-created"]?.childPid === phases["runner-enter"]?.pid,
            resumedRunner: !!phases["runner-enter"] && phases["native-resumed"]?.childPid === phases["runner-enter"]?.pid,
            targetSpawner: !!phases["runner-enter"] && phases["runner-enter"]?.pid === phases["target-spawn"]?.pid,
          },
          intervalNs: {
            psToAddType: sameClockIntervalNs(phases["ps-enter"], phases["add-type-ready"]),
            nativePrepareCreate: sameClockIntervalNs(phases["add-type-ready"], phases["native-created"]),
            assignResume: sameClockIntervalNs(phases["native-created"], phases["native-resumed"]),
            runnerToTargetSpawn: sameClockIntervalNs(phases["runner-enter"], phases["target-spawn"]),
            resumeToRunner: null, targetSpawnToParentOutput: null,
          },
          crossClockCorrelation: "UNQUALIFIED",
        });
      } catch {}
    };
    const deadlineSnapshot = (child: ChildProcess) => {
      if (snapshotStarted || !child.pid) return;
      snapshotStarted = true;
      record("deadline-snapshot-requested", { supervisorPid: child.pid, timeoutMs: 1500 });
      const script = "$all = @(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { @{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;name=$_.Name;created=$_.CreationDate.ToUniversalTime().ToString('o')} }); ConvertTo-Json -InputObject $all -Compress";
      pending = new Promise<void>(resolve => {
        execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          { encoding: "utf8", timeout: 1500, windowsHide: true }, (error, stdout) => {
            try {
              if (error) record("deadline-snapshot-unavailable", { code: error.code ?? null });
              else {
                const processes = JSON.parse(stdout.replace(/^\uFEFF/, "")) as WindowsProcessIdentity[];
                const owned = descendantsFromSnapshot(processes, child.pid!);
                const root = processes.find(value => value.pid === child.pid);
                record("deadline-snapshot-result", { supervisorPid: child.pid, root, descendants: owned.slice(0, 64), omitted: Math.max(0, owned.length - 64) });
              }
            } catch { record("deadline-snapshot-unavailable", { code: "invalid-or-missing-root" }); }
            resolve();
          });
      }).catch(() => { record("deadline-snapshot-unavailable", { code: "observer-error" }); });
    };
    record("prepared", { executablePath: executable });
    return { directory, record, collect, deadlineSnapshot, finished: () => pending };
  } catch {
    try { console.log(JSON.stringify({ stage: "initialize-evidence-unavailable", binary })); } catch {}
    return;
  }
}


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

function launch(binary: string, args: string[], evidence?: InitEvidence) {
  const spec = resolveSpawnSpec(binary, args);
  const child = spawnAgentProcess(spec.command, spec.args, {
    cwd: process.cwd(), env: process.env, shell: spec.shell,
    ...(evidence ? { traceDirectory: evidence.directory } : {}),
  });
  if (evidence) {
    initializationEvidence.set(child, evidence);
    evidence.record("launch-returned", { supervisorPid: child.pid, resolvedExecutable: spec.command });
    child.once("spawn", () => evidence.record("supervisor-spawn", { supervisorPid: child.pid }));
    child.once("close", (code, signal) => evidence.record("supervisor-close", { supervisorPid: child.pid, code, signal }));
  }
  children.push(child);
  const trace = { binary, stdout: "", stderr: "" };
  diagnostics.set(child, trace);
  child.stdout?.on("data", chunk => { trace.stdout = (trace.stdout + String(chunk)).slice(-4096); });
  child.stderr?.on("data", chunk => { trace.stderr = (trace.stderr + String(chunk)).slice(-4096); });
  return child;
}

function waitForLine(child: ChildProcess, matches: (line: string) => boolean, timeoutMs = 20_000, phase?: string): Promise<string> {
  const lines = createInterface({ input: child.stdout! });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const evidence = initializationEvidence.get(child);
      evidence?.record("deadline-fired", { phase, timeoutMs });
      const trace = diagnostics.get(child);
      console.log(JSON.stringify({ stage: "readiness-timeout", binary: trace?.binary, pid: child.pid,
        alive: child.pid ? isAlive(child.pid) : false, stdout: scrubDriverErrorMessage(trace?.stdout ?? ""), stderr: scrubDriverErrorMessage(trace?.stderr ?? "") }));
      finish(new Error("runtime output timed out"));
      evidence?.collect("deadline-phases", child);
      if (phase === "initialize") evidence?.deadlineSnapshot(child);
    }, timeoutMs);
    initializationEvidence.get(child)?.record("deadline-armed", { phase, timeoutMs });
    const onExit = (code: number | null, signal: string | null) => {
      initializationEvidence.get(child)?.record("process-exit-before-line", { phase, code, signal });
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
    lines.on("line", (line) => {
      if (matches(line)) {
        const evidence = initializationEvidence.get(child);
        evidence?.record("matching-line", { phase });
        finish(undefined, line);
        evidence?.collect("matching-line-phases", child);
      }
    });
    child.once("exit", onExit);
    child.once("error", finish);
  });
}

type WindowsProcessIdentity = { pid: number; parent: number; name: string; created: string };

function descendantsFromSnapshot(processes: WindowsProcessIdentity[], rootPid: number): WindowsProcessIdentity[] {
  const root = processes.find(process => process.pid === rootPid);
  if (!root) throw new Error(`live supervisor ${rootPid} missing from process snapshot`);
  const visited = new Set([rootPid]);
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index]!;
    for (const child of processes) {
      if (child.parent !== parent.pid || child.created < parent.created || visited.has(child.pid)) continue;
      visited.add(child.pid);
      queue.push(child);
    }
  }
  return queue.slice(1);
}


describe("initialization evidence boundaries", () => {
  it("binds exact file bytes and leaves unavailable inputs explicit", () => {
    const directory = mkdtempSync(join(tmpdir(), "initialize-input-"));
    roots.push(directory);
    const file = join(directory, "input.bin");
    writeFileSync(file, "abc");
    expect(bindInputBytes(file)).toMatchObject({ status: "bound", bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
    expect(bindInputBytes(join(directory, "missing"))).toMatchObject({ status: "unavailable" });
  });
  it("only enables the exact Antigravity case and exact flag", () => {
    expect(initializationTraceEnabled("agy_acp_server.exe", "1")).toBe(true);
    expect(initializationTraceEnabled("agy_acp_server.exe", "true")).toBe(false);
    expect(initializationTraceEnabled("cursor-agent", "1")).toBe(false);
    expect(initializationTraceEnabled("grok", "1")).toBe(false);
  });
  it("refuses cross-process, cross-clock, changed-frequency and reversed intervals", () => {
    const a: InitPhase = { stage: "a", pid: 1, clock: "windows-qpc-stopwatch", ticks: "10", frequency: "1000", highResolution: true };
    const b: InitPhase = { ...a, stage: "b", ticks: "20" };
    expect(sameClockIntervalNs(a, b)).toBe("10000000");
    expect(sameClockIntervalNs(a, { ...b, pid: 2 })).toBeNull();
    expect(sameClockIntervalNs(a, { ...b, frequency: "2000" })).toBeNull();
    expect(sameClockIntervalNs(b, a)).toBeNull();
    expect(sameClockIntervalNs(undefined, b)).toBeNull();
    expect(sameClockIntervalNs({ stage: "a", pid: 3, clock: "node-hrtime", nanoseconds: "100" },
      { stage: "b", pid: 3, clock: "node-hrtime", nanoseconds: "150" })).toBe("50");
    expect(sameClockIntervalNs(a, { stage: "b", pid: 1, clock: "node-hrtime", nanoseconds: "150" })).toBeNull();
  });
  it("preserves the producer's add-type-ready zero sentinel without accepting zero child PIDs", () => {
    const directory = mkdtempSync(join(tmpdir(), "initialize-no-child-"));
    roots.push(directory);
    const produced = { stage: "add-type-ready", pid: 10, childPid: 0, clock: "windows-qpc-stopwatch",
      ticks: "100", frequency: "10000000", highResolution: true };
    writeFileSync(join(directory, "add-type-ready.json"), JSON.stringify(produced));
    const phase = readInitPhase(directory, "add-type-ready");
    expect(phase).toEqual(produced);
    expect(sameClockIntervalNs({ ...produced, stage: "ps-enter", ticks: "50" }, phase)).toBe("5000");
    for (const stage of ["native-created", "native-resumed"]) {
      writeFileSync(join(directory, stage + ".json"), JSON.stringify({ ...produced, stage, childPid: 12 }));
      expect(readInitPhase(directory, stage)?.childPid).toBe(12);
      writeFileSync(join(directory, stage + ".json"), JSON.stringify({ ...produced, stage }));
      expect(readInitPhase(directory, stage)).toBeUndefined();
    }
    writeFileSync(join(directory, "target-spawn.json"), JSON.stringify({
      stage: "target-spawn", pid: 12, childPid: 0, clock: "node-hrtime", nanoseconds: "150",
    }));
    expect(readInitPhase(directory, "target-spawn")).toBeUndefined();
  });
  it("does not export unknown phase payload fields or claim missing phases", () => {
    const directory = mkdtempSync(join(tmpdir(), "initialize-phase-"));
    roots.push(directory);
    expect(readInitPhase(directory, "target-spawn")).toBeUndefined();
    writeFileSync(join(directory, "target-spawn.json"), JSON.stringify({
      stage: "target-spawn", pid: 3, childPid: 4, clock: "node-hrtime", nanoseconds: "150", environment: "private-payload",
    }));
    expect(readInitPhase(directory, "target-spawn")).toEqual({ stage: "target-spawn", pid: 3, childPid: 4, clock: "node-hrtime", nanoseconds: "150" });
  });
});

describe("native process snapshot ownership", () => {
  const root: WindowsProcessIdentity = { pid: 10, parent: 0, name: "supervisor", created: "2026-10-09T01:00:00Z" };
  it("excludes stale parent PID references while retaining nested owned processes", () => {
    const child = { pid: 20, parent: 10, name: "runtime", created: "2026-10-09T01:00:01Z" };
    const grandchild = { pid: 30, parent: 20, name: "tool", created: "2026-10-09T01:00:02Z" };
    const stale = { pid: 40, parent: 10, name: "unrelated", created: "2026-10-09T00:00:00Z" };
    expect(descendantsFromSnapshot([root, grandchild, stale, child], root.pid)).toEqual([child, grandchild]);
  });
  it("bounds a cycle and rejects a missing root instead of declaring no owned children", () => {
    const child = { pid: 20, parent: root.pid, name: "runtime", created: root.created };
    expect(descendantsFromSnapshot([{ ...root, parent: child.pid }, child], root.pid)).toEqual([child]);
    expect(() => descendantsFromSnapshot([child], root.pid)).toThrow("missing from process snapshot");
  });
});

function windowsDescendants(pid: number): WindowsProcessIdentity[] {
  if (process.platform !== "win32") return [];
  const script = `$found = @(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { @{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;name=$_.Name;created=$_.CreationDate.ToUniversalTime().ToString("o")} }); ConvertTo-Json -InputObject $found -Compress`;
  const snapshot = JSON.parse(execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30_000 })) as WindowsProcessIdentity[];
  return descendantsFromSnapshot(snapshot, pid);
}

async function stop(child: ChildProcess) {
  const owned = windowsDescendants(child.pid!);
  const closed = once(child, "close");
  await killProcessTree(child.pid!, { graceMs: 300 });
  await closed;
  expect(isAlive(child.pid!)).toBe(false);
  const alive = owned.filter(process => isAlive(process.pid));
  if (alive.length) {
    const script = `$found = @(); foreach ($id in @(${alive.map(process => process.pid).join(",")})) { foreach ($process in @(Get-CimInstance Win32_Process -Filter ("ProcessId=" + $id))) { $found += @{pid=$id;name=$process.Name;created=$process.CreationDate.ToString("o")} } }; ConvertTo-Json -InputObject @($found) -Compress`;
    const current = JSON.parse(execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30_000 }));
    console.log(JSON.stringify({ stage: "owned-descendant-still-alive", binary: diagnostics.get(child)?.binary, captured: alive, current }));
  }
  expect(alive).toEqual([]);
  children.splice(children.indexOf(child), 1);
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && isAlive(child.pid)) await killProcessTree(child.pid, { graceMs: 100 });
  }
  for (const [child, evidence] of initializationEvidence) {
    await evidence.finished();
    evidence.collect("afterEach-phases", child);
  }
  initializationEvidence.clear();
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
      const found = statSync(resolveCommandOnPath(binary)!);
      const expected = statSync(join(prefix, `${binary}.cmd`));
      expect({ dev: found.dev, ino: found.ino }).toEqual({ dev: expected.dev, ino: expected.ino });
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
  }, 60_000);

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
describe.skipIf(process.platform !== "win32" || !process.env.ALOOK_NATIVE_CLAUDE_PATH)("official Windows Claude native layout", () => {
  it("detects and initializes the standard native entry absent from the daemon PATH", async () => {
    const home = mkdtempSync(join(tmpdir(), "Claude native profile with spaces-"));
    roots.push(home);
    const entry = join(home, ".local", "bin", "claude.exe");
    mkdirSync(dirname(entry), { recursive: true });
    setPrefix(home);
    const system = process.env.SystemRoot!;
    vi.stubEnv("PATH", [join(system, "System32"), join(system, "System32", "WindowsPowerShell", "v1.0"), dirname(process.execPath)].join(delimiter));
    vi.stubEnv("DISABLE_AUTOUPDATER", "1");
    expect(resolveCommandOnPath("claude")).toBeNull();
    writeFileSync(entry, "broken native executable");
    const sdk = createAgentDriverSdk();
    expect((await sdk.probe({ backend: "claude" })).status).toBe("unhealthy");
    copyFileSync(process.env.ALOOK_NATIVE_CLAUDE_PATH!, entry);
    expect(resolveClaudeCommand()).toBe(entry);
    expect((await sdk.probe({ backend: "claude", command: join(home, "explicit missing.exe") })).status).toBe("unhealthy");
    const probe = await sdk.probe({ backend: "claude" });
    expect(probe.status).toBe("healthy");
    console.log(JSON.stringify({ backend: "claude-native", os: release(), node: process.version, status: probe.status,
      version: probe.status === "healthy" ? probe.version : undefined, absentFromPath: true }));
    const claude = launch(resolveClaudeCommand()!, ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
    const initialized = waitForLine(claude, line => {
      try { return JSON.parse(line).type === "control_response"; } catch { return false; }
    });
    claude.stdin!.write(JSON.stringify({ type: "control_request", request_id: "alook-qa-native-init", request: { subtype: "initialize" } }) + "\n");
    expect(JSON.parse(await initialized)).toMatchObject({ type: "control_response", response: { subtype: "success" } });
    await stop(claude);
  }, 60_000);
});

describe.skipIf(!nativePrefix)("real npm and native providers from an isolated prefix", () => {
  it.each(["codex", "opencode", "claude", "cursor", "pi", "antigravity"] as const)("detects the real %s install via its public SDK probe", async (backend) => {
    setPrefix(nativePrefix!);
    console.log(JSON.stringify({ backend, os: release(), node: process.version, nodePath: process.execPath }));
    const started = Date.now();
    const result = await createAgentDriverSdk().probe({ backend });
    console.log(JSON.stringify({ backend, elapsedMs: Date.now() - started, status: result.status, version: result.status === "healthy" ? result.version : undefined,
      error: result.status === "unhealthy" ? result.error.code : undefined }));
    expect(result.status).toBe("healthy");
  }, 60_000);

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
    const evidence = prepareInitEvidence(binary);
    const started = Date.now();
    evidence?.record("launch-requested");
    const child = launch(binary, [...args], evidence);
    const initialized = waitForLine(child, line => {
      try { return JSON.parse(line).id === 1; } catch { return false; }
    }, binary === "agy_acp_server.exe" ? 30_000 : 20_000, evidence ? "initialize" : undefined);
    evidence?.record("initialize-write-before", { requestId: 1 });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "alook-windows-qa", version: "1.0.0" },
    } }) + "\n");
    evidence?.record("initialize-write-returned", { requestId: 1, meaning: "write-return-not-target-consumption" });
    let initializedLine: string;
    try {
      initializedLine = await initialized;
    } catch (error) {
      evidence?.record("initialize-rejected");
      if (binary === "agy_acp_server.exe") {
        try {
          const late = await waitForLine(child, line => {
            try { return JSON.parse(line).id === 1; } catch { return false; }
          }, undefined, evidence ? "late-initialize" : undefined);
          console.log(JSON.stringify({ binary, phase: "diagnostic-late-initialize", elapsedMs: Date.now() - started, responseKind: JSON.parse(late).result ? "result" : "error" }));
        } catch {}
      }
      throw error;
    }
    expect(JSON.parse(initializedLine)).toMatchObject({ result: { protocolVersion: 1 } });
    evidence?.record("initialize-assertion-passed");
    console.log(JSON.stringify({ binary, phase: "initialize", elapsedMs: Date.now() - started }));
    if (binary === "agy_acp_server.exe") {
      const session = waitForLine(child, line => {
        try { return JSON.parse(line).id === 2; } catch { return false; }
      }, undefined, evidence ? "session/new" : undefined);
      evidence?.record("session-new-write-before", { requestId: 2 });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: nativePrefix!, mcpServers: [] } }) + "\n");
      evidence?.record("session-new-write-returned", { requestId: 2 });
      const reply = JSON.parse(await session);
      expect(reply.result !== undefined || reply.error !== undefined).toBe(true);
      console.log(JSON.stringify({ binary, phase: "session/new", elapsedMs: Date.now() - started, errorCode: reply.error?.code }));
    }
    evidence?.record("stop-before");
    await stop(child);
    evidence?.record("stop-returned");
    evidence?.collect("case-complete-phases", child);
  }, 60_000);

  it("classifies real Grok authentication separately from installation", async () => {
    setPrefix(nativePrefix!);
    expect(probeCliRuntime("grok").status).toBe("healthy");
    const probe = await createAgentDriverSdk().probe({ backend: "grok" });
    console.log(JSON.stringify({ backend: "grok", status: probe.status, error: probe.status === "unhealthy" ? probe.error.code : undefined }));
    if (probe.status === "unhealthy") expect(probe.error.code).toBe("grok_acp_authentication_failed");
  });

  it("creates and disposes a real persistent Pi session through the default adapter without a model request", async () => {
    setPrefix(nativePrefix!);
    vi.stubEnv("PI_OFFLINE", "1");
    const piSdk = await loadPiSdkModule() as unknown as {
      AgentSession: { prototype: { prompt(text: string): Promise<void>; dispose(): void } };
    };
    const prompt = vi.spyOn(piSdk.AgentSession.prototype, "prompt");
    const dispose = vi.spyOn(piSdk.AgentSession.prototype, "dispose");
    let lane: Awaited<ReturnType<PiDriver["openLane"]>> | undefined;
    try {
      const started = Date.now();
      lane = await new PiDriver().openLane(fakeLaunchContext("pi", nativePrefix!));
      expect(typeof lane.currentSessionId).toBe("string");
      expect(lane.currentSessionId.length).toBeGreaterThan(0);
      const sessionId = lane.currentSessionId;
      expect(prompt).not.toHaveBeenCalled();
      console.log(JSON.stringify({ backend: "pi", phase: "default-adapter-created", sessionId, elapsedMs: Date.now() - started }));
      await lane.stop();
      lane = undefined;
      expect(dispose).toHaveBeenCalledOnce();
      expect(dispose.mock.results[0]).toMatchObject({ type: "return" });
      console.log(JSON.stringify({ backend: "pi", phase: "default-adapter-disposed", sessionId, promptCalls: prompt.mock.calls.length,
        disposeCalls: dispose.mock.calls.length, elapsedMs: Date.now() - started, node: process.version }));
    } finally {
      try {
        await lane?.stop();
      } finally {
        prompt.mockRestore();
        dispose.mockRestore();
      }
    }
  });
});
