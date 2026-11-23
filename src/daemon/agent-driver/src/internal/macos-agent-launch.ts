import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { release } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Duplex } from "node:stream";

export const macosAgentLauncher = "ALOOK_MACOS_AGENT_LAUNCHER";

interface LaunchOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  stdin?: "pipe" | "ignore";
  macosIdentity?: boolean | "managed-launcher";
}

interface AgentLaunch {
  control: Duplex;
  backendPid?: number;
  cleanedUp?: boolean;
  closed: Promise<void>;
  stopping?: Promise<void>;
}

const launches = new Map<number, AgentLaunch>();
const machoHeaders = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

function isMachO(command: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(command, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return false;
    const header = Buffer.alloc(4);
    return readSync(fd, header, 0, header.length, 0) === header.length && machoHeaders.has(header.readUInt32BE());
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function canLaunchMacosAgents(): boolean {
  const launcher = process.env[macosAgentLauncher];
  const entrypoint = process.argv[1];
  if (process.platform !== "darwin" || Number.parseInt(release(), 10) < 20
    || !launcher || !isAbsolute(launcher) || !entrypoint || !isAbsolute(entrypoint)) return false;
  try {
    accessSync(launcher, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

function launchPayload(command: string, args: string[], options: LaunchOptions): Buffer {
  const env = Object.entries(options.env ?? process.env)
    .filter(([key, value]) => key !== macosAgentLauncher && value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  const argv = [command, ...args];
  const fields = [resolve(options.cwd), ...argv, ...env];
  if (fields.some((field) => field.includes("\0"))) throw new TypeError("Agent launch argument contains NUL");
  return Buffer.concat([
    Buffer.from(fields[0] + "\0"),
    uint32(argv.length),
    Buffer.from(argv.join("\0") + "\0"),
    uint32(env.length),
    ...(env.length ? [Buffer.from(env.join("\0") + "\0")] : []),
  ]);
}

export function spawnMacosAgent(command: string, args: string[], options: LaunchOptions): ChildProcess | undefined {
  const launcher = process.env[macosAgentLauncher];
  const entrypoint = process.argv[1];
  if (!launcher || !entrypoint || !canLaunchMacosAgents() || options.shell || !command.includes("/")) return undefined;
  const executable = resolve(options.cwd, command);
  if (options.macosIdentity !== "managed-launcher" && !isMachO(executable)) return undefined;

  const payload = launchPayload(executable, args, options);
  if (payload.byteLength > 4 * 1024 * 1024) throw new Error("macOS agent launch environment is too large");
  const processHandle = spawn(launcher, ["--alook-agent-supervise", process.execPath, entrypoint], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: [options.stdin ?? "pipe", "pipe", "pipe", "pipe"],
    detached: true,
  });
  const pid = processHandle.pid;
  if (!pid) return processHandle;
  const control = processHandle.stdio[3] as Duplex;
  const launch: AgentLaunch = {
    control,
    closed: new Promise((done) => processHandle.once("close", () => {
      launches.delete(pid);
      done();
    })),
  };
  launches.set(pid, launch);
  control.on("error", () => control.destroy());
  let reply = "";
  control.on("data", (chunk: Buffer) => {
    if (chunk.toString() === "C") {
      launch.cleanedUp = true;
      return;
    }
    if (launch.backendPid !== undefined || launch.stopping) return;
    reply += chunk.toString();
    if (/^[1-9]\d{0,9}\n$/.test(reply) && Number(reply) > 1) {
      launch.backendPid = Number(reply);
      control.write("A");
    } else if (!/^\d{0,10}$/.test(reply)) {
      control.destroy();
    }
  });
  control.write(Buffer.concat([uint32(payload.byteLength), payload]));
  return processHandle;
}

export function stopMacosAgent(pid: number, graceMs: number): Promise<void> | undefined {
  const launch = launches.get(pid);
  if (!launch) return undefined;
  launch.stopping ??= Promise.resolve().then(async () => {
    launch.control.end(launch.backendPid === undefined ? undefined : uint32(Math.trunc(Math.max(0, Math.min(99_999, graceMs)))));
    await launch.closed;
    if (!launch.cleanedUp) {
      throw new Error(`macOS agent supervisor ${pid} could not finish cleanup`);
    }
  });
  return launch.stopping;
}
