import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { resolveCommandOnPath, type ProbeDeps } from "../../internal/probe.js";

interface CodexCommandDeps extends ProbeDeps {
  readonly applicationsDirectory?: string;
}

export type CodexBackendId = "codex" | "codex-app" | "codex-cli";

export function resolveCodexNpmBinary(command: string, arch = process.arch): { command: string; packageRoot: string } | undefined {
  if (!isAbsolute(command) || (arch !== "arm64" && arch !== "x64")) return undefined;
  try {
    const wrapper = realpathSync(command);
    const packageRoot = dirname(dirname(wrapper));
    if (!wrapper.endsWith("/lib/node_modules/@openai/codex/bin/codex.js")
      || /\/(?:\.bun|\.pnpm|packages)\//.test(wrapper)
      || existsSync(join(dirname(dirname(packageRoot)), ".modules.yaml"))) return undefined;
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== "@openai/codex" || manifest.bin?.codex !== "bin/codex.js") return undefined;
    const platformPackage = `@openai/codex-darwin-${arch}`;
    const packagePath = createRequire(wrapper).resolve(`${platformPackage}/package.json`);
    const nativeManifest = JSON.parse(readFileSync(packagePath, "utf8"));
    if (nativeManifest.name !== manifest.name || nativeManifest.version !== `${manifest.version}-darwin-${arch}`) return undefined;
    const target = arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
    const native = join(dirname(packagePath), "vendor", target, "bin", "codex");
    accessSync(native, constants.X_OK);
    return statSync(native).isFile() ? { command: native, packageRoot } : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCodexCommand(
  command?: string,
  deps: CodexCommandDeps = {},
  platform: NodeJS.Platform = process.platform,
  backend: CodexBackendId = "codex",
): string | undefined {
  const explicit = command?.trim();
  if (explicit) return explicit;
  if (backend !== "codex-app") {
    const onPath = resolveCommandOnPath("codex", deps);
    if (onPath) return onPath;
    if (backend === "codex-cli") return undefined;
  }
  if (platform !== "darwin") return undefined;
  const roots = [deps.applicationsDirectory ?? "/Applications", join(deps.homeDir ?? homedir(), "Applications")];
  for (const app of ["Codex.app", "ChatGPT.app"]) {
    for (const root of roots) {
      for (const binary of [["codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"], ["codex"]]) {
        const candidate = join(root, app, "Contents", "Resources", ...binary);
        try {
          accessSync(candidate, constants.X_OK);
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          continue;
        }
      }
    }
  }
  return undefined;
}
