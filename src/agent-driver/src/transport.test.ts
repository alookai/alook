import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentDriverLineFramer,
  isAgentDriverProcessAlive,
  serializeAgentDriverJsonRpcRequest,
  spawnAgentDriverProcess,
  terminateAgentDriverProcessTree,
  tryParseAgentDriverJsonLine,
} from "./transport.js";

const spawned: ChildProcess[] = [];
const spawnedPids: number[] = [];

function spawnIdleChild(opts: { detached?: boolean } = {}): ChildProcess {
  const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: opts.detached,
  });
  spawned.push(proc);
  return proc;
}

function spawnSigtermImmuneChild(opts: { detached?: boolean } = {}): ChildProcess {
  const proc = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: "ignore", detached: opts.detached },
  );
  spawned.push(proc);
  return proc;
}

afterEach(() => {
  for (const proc of spawned.splice(0)) {
    if (proc.pid && isAgentDriverProcessAlive(proc.pid)) {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  }
  for (const pid of spawnedPids.splice(0)) {
    if (isAgentDriverProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  }
});

async function waitForProcessToExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && isAgentDriverProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("terminateAgentDriverProcessTree", () => {
  it("kills a real detached process group, including a TERM-immune grandchild", async () => {
    if (process.platform === "win32") return;
    const childScript = "process.on('SIGTERM',()=>{});console.log('child:'+process.pid);setInterval(()=>{},1000)";
    const leaderScript = [
      "const {spawn}=require('node:child_process')",
      `spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:['ignore','inherit','ignore']})`,
      "setInterval(()=>{},1000)",
    ].join(";");
    const proc = spawnAgentDriverProcess(process.execPath, ["-e", leaderScript], {
      cwd: process.cwd(),
      env: process.env,
    });
    spawned.push(proc);
    await new Promise((resolve) => proc.once("spawn", resolve));
    const childPid = await new Promise<number>((resolve, reject) => {
      proc.once("error", reject);
      proc.stdout?.on("data", (chunk: Buffer) => {
        const match = chunk.toString().match(/child:(\d+)/);
        if (match) resolve(Number(match[1]));
      });
    });
    spawnedPids.push(childPid);

    expect(isAgentDriverProcessAlive(proc.pid!)).toBe(true);
    expect(isAgentDriverProcessAlive(childPid)).toBe(true);
    await terminateAgentDriverProcessTree(proc.pid!, { graceMs: 300 });
    await waitForProcessToExit(childPid);
    expect(isAgentDriverProcessAlive(proc.pid!)).toBe(false);
    expect(isAgentDriverProcessAlive(childPid)).toBe(false);
  });

  it("falls back to the direct pid for a non-detached child", async () => {
    const proc = spawnIdleChild({ detached: false });
    await new Promise((resolve) => proc.once("spawn", resolve));

    await terminateAgentDriverProcessTree(proc.pid!, { graceMs: 1_000 });
    expect(isAgentDriverProcessAlive(proc.pid!)).toBe(false);
  });

  it("resolves for an already-dead or invalid pid", async () => {
    const proc = spawnIdleChild({ detached: false });
    await new Promise((resolve) => proc.once("spawn", resolve));
    const pid = proc.pid!;
    process.kill(pid, "SIGKILL");
    await new Promise((resolve) => proc.once("exit", resolve));

    await expect(terminateAgentDriverProcessTree(pid)).resolves.toBeUndefined();
    await expect(terminateAgentDriverProcessTree(0)).resolves.toBeUndefined();
    await expect(terminateAgentDriverProcessTree(-1)).resolves.toBeUndefined();
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const proc = spawnSigtermImmuneChild({ detached: false });
    await new Promise((resolve) => proc.once("spawn", resolve));

    await terminateAgentDriverProcessTree(proc.pid!, { graceMs: 300 });
    expect(isAgentDriverProcessAlive(proc.pid!)).toBe(false);
  });

  it("normalizes infinite, NaN, and negative grace durations to the bounded default", async () => {
    const invalidGraceValues = [Number.POSITIVE_INFINITY, Number.NaN, -1];
    const processes = invalidGraceValues.map(() => spawnSigtermImmuneChild({ detached: false }));
    await Promise.all(processes.map((proc) => new Promise((resolve) => proc.once("spawn", resolve))));
    // Give each real child time to install its SIGTERM handler before testing
    // that invalid durations do not accidentally collapse to immediate KILL.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const terminations = processes.map((proc, index) =>
      terminateAgentDriverProcessTree(proc.pid!, { graceMs: invalidGraceValues[index] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const proc of processes) expect(isAgentDriverProcessAlive(proc.pid!)).toBe(true);

    await Promise.all(terminations);
    await Promise.all(processes.map((proc) => waitForProcessToExit(proc.pid!)));
    for (const proc of processes) expect(isAgentDriverProcessAlive(proc.pid!)).toBe(false);
  });
});

describe("spawnAgentDriverProcess", () => {
  it("creates a process-group leader on POSIX", async () => {
    if (process.platform === "win32") return;
    const proc = spawnAgentDriverProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env: process.env,
    });
    spawned.push(proc);
    await new Promise((resolve) => proc.once("spawn", resolve));

    const { execFileSync } = await import("node:child_process");
    const pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(proc.pid)], { encoding: "utf8" }).trim();
    expect(Number(pgid)).toBe(proc.pid);
  });

  it("pipes output and forwards cwd, env, shell, and stdin disposition", () => {
    const proc = spawnAgentDriverProcess(process.execPath, ["-e", "process.exit(0)"], {
      cwd: process.cwd(),
      env: { ...process.env, ALOOK_AGENT_DRIVER_TEST: "1" },
      shell: false,
      stdin: "ignore",
    });
    spawned.push(proc);
    expect(proc.stdin).toBeNull();
    expect(proc.stdout).not.toBeNull();
    expect(proc.stderr).not.toBeNull();
  });
});

describe("AgentDriverLineFramer", () => {
  it("preserves complete non-empty lines across split, multi-line, and partial chunks", () => {
    const framer = new AgentDriverLineFramer();
    expect(framer.push(Buffer.from("fir"))).toEqual([]);
    expect(framer.push(Buffer.from("st\n\nsecond\npar"))).toEqual(["first", "second"]);
    expect(framer.push(Buffer.from("tial\nthird\n"))).toEqual(["partial", "third"]);
  });

  it("preserves a UTF-8 code point split across byte chunks", () => {
    const framer = new AgentDriverLineFramer();
    const bytes = Buffer.from("你\n");
    expect(framer.push(bytes.subarray(0, 1))).toEqual([]);
    expect(framer.push(bytes.subarray(1))).toEqual(["你"]);
  });
});

describe("JSON transport helpers", () => {
  it("serializes a JSON-RPC envelope and preserves an explicit id", () => {
    expect(JSON.parse(serializeAgentDriverJsonRpcRequest("thread/start", { cwd: "/tmp" }, 7))).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "thread/start",
      params: { cwd: "/tmp" },
    });
  });

  it("generates unique ids when omitted", () => {
    const first = JSON.parse(serializeAgentDriverJsonRpcRequest("m", {}));
    const second = JSON.parse(serializeAgentDriverJsonRpcRequest("m", {}));
    expect(first.id).toBeTruthy();
    expect(first.id).not.toBe(second.id);
  });

  it("parses valid JSON and returns null for invalid, empty, and JSON null", () => {
    expect(tryParseAgentDriverJsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseAgentDriverJsonLine("not json")).toBeNull();
    expect(tryParseAgentDriverJsonLine("")).toBeNull();
    expect(tryParseAgentDriverJsonLine("null")).toBeNull();
  });
});
