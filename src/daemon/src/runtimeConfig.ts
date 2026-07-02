/**
 * RuntimeConfig — the structured, versioned agent runtime configuration.
 *
 * This is what the server stores per agent and pushes down in `agent:start`'s
 * `config`. It captures the FULL config surface — which runtime, which model,
 * which provider/endpoint, mode, reasoning effort — as structured data (not bare
 * strings), mirroring how a production daemon models it.
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
   * same config the server downlinks via `agent:start`. The daemon does not
   * invent these; it fills the LaunchContext from them.
   */
  agentName?: string;
  /** The agent's @mention handle (e.g. "@cindy"). */
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

/* ------------------------------------------------------------------ */
/* Resolution — RuntimeConfig → flat launch fields                     */
/* ------------------------------------------------------------------ */

/**
 * Flat fields drivers consume, derived from a RuntimeConfig. `model` is the
 * resolved model id (or undefined ⇒ runtime default); `fastMode` is the mode
 * flattened to a bool; `envVars` carries provider-derived env (custom endpoint
 * keys, custom-model option, Pi provider key).
 */
export interface ResolvedLaunchFields {
  /** Resolved model id, or undefined to mean "runtime default". */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  fastMode: boolean;
  command?: string;
  disallowedTools?: string;
  /** User-supplied env (controlled keys stripped). Lower-precedence layer. */
  envVars: Record<string, string>;
  /**
   * Provider/model-DERIVED env (custom endpoint keys, Claude custom-model option,
   * Pi provider key). Kept separate from `envVars` so the spawn-env merge can put
   * these in a protected layer that user/driver env can't accidentally shadow.
   */
  providerEnv: Record<string, string>;
}

/** Env key per Pi built-in provider id. Extend as providers are added. */
const PI_BUILTIN_PROVIDER_ENV_KEYS: Record<string, string> = {
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Env keys the host must not set directly — provider config owns them. */
const CONTROLLED_ENV_KEYS = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  ...Object.values(PI_BUILTIN_PROVIDER_ENV_KEYS),
]);

/**
 * Resolve from a possibly-absent RuntimeConfig (test contexts may omit it):
 * returns runtime-default fields when `config` is undefined.
 */
export function resolveLaunchFieldsOrDefault(config: RuntimeConfig | undefined): ResolvedLaunchFields {
  if (!config) return { fastMode: false, envVars: {}, providerEnv: {} };
  return resolveLaunchFields(config);
}

export function resolveLaunchFields(config: RuntimeConfig): ResolvedLaunchFields {
  const envVars: Record<string, string> = {};
  const providerEnv: Record<string, string> = {};

  // User env, minus the keys provider config controls.
  for (const [k, v] of Object.entries(config.envVars ?? {})) {
    if (!CONTROLLED_ENV_KEYS.has(k)) envVars[k] = v;
  }

  // Model → id + custom-model env (Claude custom models go via env, not --model).
  let model: string | undefined;
  if (config.model.kind === "named") model = config.model.name;
  else if (config.model.kind === "custom") {
    model = config.model.name;
    if (config.runtime === "claude") providerEnv.ANTHROPIC_CUSTOM_MODEL_OPTION = config.model.name;
  }

  // Provider → endpoint / key env.
  const p = config.provider;
  if (p?.kind === "custom" && config.runtime === "claude") {
    providerEnv.ANTHROPIC_BASE_URL = p.apiUrl;
    providerEnv.ANTHROPIC_API_KEY = p.apiKey;
  } else if (p?.kind === "pi-builtin") {
    const key = PI_BUILTIN_PROVIDER_ENV_KEYS[p.providerId];
    if (key) providerEnv[key] = p.apiKey;
  }

  return {
    model,
    reasoningEffort: config.reasoningEffort,
    fastMode: config.mode.kind === "fast",
    command: config.command,
    disallowedTools: config.disallowedTools,
    envVars,
    providerEnv,
  };
}
