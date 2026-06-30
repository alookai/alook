/**
 * Claude provider isolation.
 *
 * When an agent is configured with a *custom* Anthropic-compatible provider
 * (custom `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`), we must not let it read
 * or write the host user's global `~/.claude` config. We give it a private HOME
 * and CLAUDE_CONFIG_DIR under `.alook/claude-provider/`, symlinking the host's
 * skills/commands so they remain available.
 *
 * No custom provider ⇒ empty env (use the host's normal Claude config).
 */
import * as fs from "fs";
import * as path from "path";
import type { LaunchContext } from "../types.js";

export function buildClaudeProviderIsolationEnv(ctx: LaunchContext): NodeJS.ProcessEnv {
  const hasCustomProvider = Boolean(process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_API_KEY);
  if (!hasCustomProvider) return {};

  const root = path.join(ctx.workingDirectory, ".alook", "claude-provider");
  const home = path.join(root, "home");
  const configDir = path.join(home, ".claude");
  fs.mkdirSync(configDir, { recursive: true });

  // Best-effort symlink host skills/commands into the isolated config.
  const hostClaude = path.join(process.env.HOME || ".", ".claude");
  for (const sub of ["skills", "commands"]) {
    const target = path.join(hostClaude, sub);
    const link = path.join(configDir, sub);
    try {
      if (fs.existsSync(target) && !fs.existsSync(link)) fs.symlinkSync(target, link);
    } catch {
      /* symlink optional */
    }
  }

  return {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
  };
}
