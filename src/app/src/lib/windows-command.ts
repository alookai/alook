import { existsSync, realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";

export const TRUSTED_WINDOWS_COMMAND_PROCESSOR = String.raw`C:\Windows\System32\cmd.exe`;
export const TRUSTED_WINDOWS_POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
export const TRUSTED_WINDOWS_TASKKILL = String.raw`C:\Windows\System32\taskkill.exe`;
const TRUSTED_WINDOWS_ROOT = String.raw`C:\Windows`;
const TRUSTED_WINDOWS_POWERSHELL_MODULES = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\Modules`;

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

export function resolveTrustedWindowsSystemExecutable(
  expectedPath: string,
  filesystem: WindowsCommandFilesystem = productionFilesystem,
): string {
  if (!win32.isAbsolute(expectedPath) || !filesystem.exists(expectedPath)) {
    throw new Error(`trusted Windows system executable is missing: ${expectedPath}`);
  }
  const canonical = filesystem.realpath(expectedPath);
  if (canonical.toLowerCase() !== expectedPath.toLowerCase() || !filesystem.isFile(canonical)) {
    throw new Error(`trusted Windows system executable failed canonical regular-file validation: ${canonical}`);
  }
  return canonical;
}

export function trustedWindowsAuthorityEnvironment(): NodeJS.ProcessEnv {
  return {
    SystemRoot: TRUSTED_WINDOWS_ROOT,
    WINDIR: TRUSTED_WINDOWS_ROOT,
    ComSpec: TRUSTED_WINDOWS_COMMAND_PROCESSOR,
    PSModulePath: TRUSTED_WINDOWS_POWERSHELL_MODULES,
  };
}

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
  let canonical: string;
  try {
    canonical = resolveTrustedWindowsSystemExecutable(TRUSTED_WINDOWS_COMMAND_PROCESSOR, filesystem);
  } catch (error) {
    throw new Error(String(error).replace("trusted Windows system executable", "trusted Windows command processor"));
  }
  const commandLine = `"${[shim, ...args].map(quoteCmdToken).join(" ")}"`;
  return {
    command: canonical,
    args: ["/d", "/s", "/v:off", "/c", commandLine],
  };
}
