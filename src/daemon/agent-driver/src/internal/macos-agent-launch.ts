import { accessSync, closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const macosAgentLauncher = "ALOOK_MACOS_AGENT_LAUNCHER";

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
  if (process.platform !== "darwin" || !launcher || !isAbsolute(launcher)) return false;
  try {
    accessSync(launcher, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function macosAgentSpawnSpec(command: string, args: string[], options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
}): { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined {
  const launcher = process.env[macosAgentLauncher];
  if (!launcher || !canLaunchMacosAgents() || options.shell || !command.includes("/")) return undefined;
  const executable = resolve(options.cwd, command);
  if (!isMachO(executable)) return undefined;

  const environment = { ...(options.env ?? process.env) };
  delete environment[macosAgentLauncher];
  return { command: launcher, args: ["--alook-agent-exec", executable, ...args], env: environment };
}
