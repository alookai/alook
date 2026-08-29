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
 * The host resolves launch fields from this config. Reasoning effort is also a
 * desired live setting: a capable driver may apply it at a safe turn boundary,
 * while other drivers relaunch with the same session context.
 */

export const RUNTIME_CONFIG_VERSION = 1;

export const KNOWN_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type KnownReasoningEffort = (typeof KNOWN_REASONING_EFFORTS)[number];
export type ReasoningEffort = KnownReasoningEffort | (string & Record<never, never>);

export type ReasoningEffortOption = {
  value: ReasoningEffort;
  description?: string;
};

/**
 * Machine/runtime-scoped startup catalog. The historical `reasoning` wire
 * field jointly carries model IDs and any model-specific reasoning metadata;
 * models with no effort metadata use an empty options array.
 */
export type RuntimeReasoningCatalog = {
  readonly updateMode: "live_next_turn" | "context_preserving_restart" | "unsupported";
  readonly defaultModelId?: string;
  readonly models: readonly {
    readonly id: string;
    readonly supportedReasoningEfforts: readonly ReasoningEffortOption[];
    readonly defaultReasoningEffort?: ReasoningEffort;
  }[];
};

/** Model selection — structured, not a bare string. */
export type ModelConfig =
  | { kind: "default" } // use the runtime's default model
  | { kind: "named"; name: string } // any explicit launchable model name
  | { kind: "custom"; name: string }; // legacy-compatible custom/BYO shape

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
  /** "claude" | "codex" | "cursor" | "opencode" | "pi" | "mock" */
  runtime: string;
  model: ModelConfig;
  mode: ModeConfig;
  reasoningEffort?: ReasoningEffort;
  /** Server-generated last-write-wins ordering token for desired runtime config. */
  runtimeConfigRevision?: number;
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
   * The agent's global @mention handle, `@name#0042` (e.g. "@Gus#4821").
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
export function makeRuntimeConfig(
  input: Partial<RuntimeConfig> & { runtime: string },
): RuntimeConfig {
  return {
    version: RUNTIME_CONFIG_VERSION,
    runtime: input.runtime,
    model: input.model ?? { kind: "default" },
    mode: input.mode ?? { kind: "default" },
    reasoningEffort: input.reasoningEffort,
    runtimeConfigRevision: input.runtimeConfigRevision,
    provider: input.provider,
    command: input.command,
    disallowedTools: input.disallowedTools,
    envVars: input.envVars,
    agentName: input.agentName,
    agentHandle: input.agentHandle,
    instruction: input.instruction,
  };
}
