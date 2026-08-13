import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { extname } from "node:path";

export interface PackageManagerCommand {
  file: string;
  args: string[];
  shell?: true;
}

export function resolvePackageManagerCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath,
  platform = process.platform,
): PackageManagerCommand {
  const npmExecPath = env.npm_execpath;
  if (!npmExecPath) {
    return platform === "win32"
      ? { file: "pnpm", args, shell: true }
      : { file: "pnpm", args };
  }

  const extension = extname(npmExecPath).toLowerCase();
  if ([".js", ".cjs", ".mjs"].includes(extension)) {
    return { file: nodeExecutable, args: [npmExecPath, ...args] };
  }
  if (platform === "win32" && [".bat", ".cmd"].includes(extension)) {
    return { file: npmExecPath, args, shell: true };
  }
  return { file: npmExecPath, args };
}

export function execPackageManagerSync(
  args: string[],
  options: ExecFileSyncOptions,
): Buffer | string {
  const command = resolvePackageManagerCommand(args);
  return execFileSync(command.file, command.args, {
    ...options,
    shell: command.shell,
  });
}
