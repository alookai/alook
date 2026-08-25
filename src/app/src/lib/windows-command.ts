import { existsSync, realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";

export const TRUSTED_WINDOWS_COMMAND_PROCESSOR = String.raw`C:\Windows\System32\cmd.exe`;

interface WindowsCommandFilesystem {
  exists(path: string): boolean;
  realpath(path: string): string;
  isFile(path: string): boolean;
}

const productionFilesystem: WindowsCommandFilesystem = {
  exists: existsSync,
  realpath: (path) => realpathSync.native(path),
  isFile: (path) => statSync(path).isFile(),
};

export interface WindowsCommandInvocation {
  command: string;
  args: string[];
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function resolveNpmShim(
  command: string,
  env: NodeJS.ProcessEnv,
  filesystem: WindowsCommandFilesystem,
): string | undefined {
  const basename = win32.basename(command).toLowerCase();
  if (win32.extname(basename) === ".cmd") {
    if (basename !== "npm.cmd" && basename !== "npx.cmd") {
      throw new Error(`refusing untrusted Windows command shim: ${basename}`);
    }
    if (!win32.isAbsolute(command) || !filesystem.exists(command) || !filesystem.isFile(command)) {
      throw new Error(`Windows command shim is not an absolute regular file: ${command}`);
    }
    return filesystem.realpath(command);
  }
  if (basename !== "npm" && basename !== "npx") return undefined;
  const pathValue = environmentValue(env, "PATH");
  const candidate = pathValue?.split(";")
    .map((directory) => win32.join(directory, `${basename}.cmd`))
    .find((path) => filesystem.exists(path) && filesystem.isFile(path));
  if (!candidate) throw new Error(`could not resolve internal Windows ${basename}.cmd shim`);
  return filesystem.realpath(candidate);
}

function quoteCmdToken(value: string): string {
  if (/[\0\r\n"]/.test(value)) throw new Error("Windows command argument contains an unsupported control character or quote");
  return `"${value.replaceAll("%", "%%")}"`;
}

export function createWindowsCommandInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  filesystem: WindowsCommandFilesystem = productionFilesystem,
): WindowsCommandInvocation {
  const shim = resolveNpmShim(command, env, filesystem);
  if (!shim) return { command, args };
  if (!filesystem.exists(TRUSTED_WINDOWS_COMMAND_PROCESSOR)) {
    throw new Error(`trusted Windows command processor is missing: ${TRUSTED_WINDOWS_COMMAND_PROCESSOR}`);
  }
  const canonical = filesystem.realpath(TRUSTED_WINDOWS_COMMAND_PROCESSOR);
  if (
    canonical.toLowerCase() !== TRUSTED_WINDOWS_COMMAND_PROCESSOR.toLowerCase() ||
    !filesystem.isFile(canonical)
  ) {
    throw new Error(`trusted Windows command processor failed canonical regular-file validation: ${canonical}`);
  }
  const commandLine = `"${[shim, ...args].map(quoteCmdToken).join(" ")}"`;
  return {
    command: canonical,
    args: ["/d", "/s", "/v:off", "/c", commandLine],
  };
}
