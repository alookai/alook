/**
 * RuntimeConfig — the structured, versioned agent runtime configuration.
 *
 * This is what the server stores per agent and pushes down in `agent:wake`'s
 * `config`. It captures the FULL config surface — which runtime, which model,
 * which provider/endpoint, mode, reasoning effort — as structured data (not bare
 * strings), mirroring how a production daemon models it.
 *
 * Lifted from `src/daemon/src/runtimeConfig.ts` into `@alook/shared` because
 * `HostCommand`'s `agent:wake.config` field needs this type, and the wake
 * producer/consumer (`src/web` + `src/wake-worker`, both Workers) has no path
 * to import from the CLI/daemon package. `src/daemon` re-exports
 * `RuntimeConfig`/`makeRuntimeConfig` from here; `resolveLaunchFields`/
 * `ResolvedLaunchFields` stay daemon-only (host-side launch resolution, not
 * needed server-side).
 *
 * The host doesn't act on `RuntimeConfig` directly; it `resolveLaunchFields()`s
 * it into flat launch fields (CLI args + env) that each driver consumes. Config
 * is start-time: changing it means relaunching the agent with a new RuntimeConfig
 * (there is no live-reconfigure path — model/effort are spawn-time args).
 */

export const RUNTIME_CONFIG_VERSION = 1;

/** Reasoning/thinking effort. */
export type ReasoningEffort = "low" | "medium" | "high";

/** Model selection — structured, not a bare string. */
export type ModelConfig =
  | { kind: "default" } // use the runtime's default model
  | { kind: "named"; name: string } // a specific catalog model
  | { kind: "custom"; name: string }; // a custom/BYO model id

/**
 * Provider / endpoint selection — distinct from model. Lets a host point a
 * runtime at a custom endpoint or a built-in multi-provider (Pi).
 */
export type ProviderConfig =
  | { kind: "default" }
  | { kind: "custom"; apiUrl: string; apiKey: string } // e.g. Claude-compatible endpoint
  | { kind: "pi-builtin"; providerId: string; apiKey: string }; // Pi multi-provider

/** Execution mode (e.g. fast lane). */
export type ModeConfig = { kind: "default" | "fast" };

export interface RuntimeConfig {
  version: number;
  /** "claude" | "codex" | "gemini" | "kimi" | "pi" | "copilot" | "cursor" | "opencode" | "antigravity" | "mock" */
  runtime: string;
  model: ModelConfig;
  mode: ModeConfig;
  reasoningEffort?: ReasoningEffort;
  provider?: ProviderConfig;
  /** Override the runtime's default executable path. */
  command?: string;
  /** Override the runtime's disallowed-tools list. */
  disallowedTools?: string;
  /** Extra host-supplied env vars (controlled keys are stripped on resolve). */
  envVars?: Record<string, string>;
  /**
   * Agent identity — the SERVER's truth about who this agent is, carried in the
   * same config the server downlinks via `agent:wake`. The daemon does not
   * invent these; it fills the LaunchContext from them.
   */
  agentName?: string;
  /**
   * The agent's global @mention handle, `@name#0042` (e.g. "@cindy#4821").
   * Every account in Alook — human or agent — has a name plus a 4-digit
   * discriminator; this is the `@`-prefixed pair, unique even when names
   * collide.
   */
  agentHandle?: string;
  /** The agent's standing instruction / role (becomes the standing prompt). */
  instruction?: string;
}

/* ------------------------------------------------------------------ */
/* Construction / normalization                                        */
/* ------------------------------------------------------------------ */

/** Build a fully-defaulted RuntimeConfig from a partial input. */
export function makeRuntimeConfig(input: Partial<RuntimeConfig> & { runtime: string }): RuntimeConfig {
  return {
    version: RUNTIME_CONFIG_VERSION,
    runtime: input.runtime,
    model: input.model ?? { kind: "default" },
    mode: input.mode ?? { kind: "default" },
    reasoningEffort: input.reasoningEffort,
    provider: input.provider,
    command: input.command,
    disallowedTools: input.disallowedTools,
    envVars: input.envVars,
    agentName: input.agentName,
    agentHandle: input.agentHandle,
    instruction: input.instruction,
  };
}
