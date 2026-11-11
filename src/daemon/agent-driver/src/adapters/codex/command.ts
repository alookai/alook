import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveCommandOnPath, type ProbeDeps } from "../../internal/probe.js";

interface CodexCommandDeps extends ProbeDeps {
  readonly applicationsDirectory?: string;
}

export type CodexBackendId = "codex" | "codex-app" | "codex-cli";

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
      const candidate = join(root, app, "Contents", "Resources", "codex");
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}
