import { Command } from "commander";
import { readFileSync } from "fs";

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

export function collectRepeated(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function readBody(opts: { body?: string; bodyFile?: string }): string {
  if (opts.body && opts.bodyFile) {
    console.error("Error: --body and --body-file are mutually exclusive");
    process.exit(1);
  }
  if (opts.bodyFile) return readFileSync(opts.bodyFile, "utf-8");
  return opts.body ?? "";
}
