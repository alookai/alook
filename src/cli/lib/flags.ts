import { Command } from "commander";

export function flagOrEnv(
  cmd: Command,
  flagName: string,
  envKey: string,
  fallback: string,
): string {
  const opts = cmd.opts();
  if (opts[flagName]) return opts[flagName];
  if (process.env[envKey]) return process.env[envKey]!;
  return fallback;
}

export function resolveAgentId(opts: { agent_id?: string }): string {
  const id = opts.agent_id || process.env.ALOOK_AGENT_ID;
  if (!id) {
    console.error("Error: --agent_id is required (or set ALOOK_AGENT_ID env var)");
    process.exit(1);
  }
  return id;
}
