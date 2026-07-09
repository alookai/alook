/**
 * RuntimeConfig — the structured, versioned agent runtime configuration.
 *
 * The canonical `RuntimeConfig`/`makeRuntimeConfig` now live in
 * `@alook/shared/runtime-config` (lifted there so the `src/web` wake producer
 * and `src/wake-worker` consumer, neither of which can depend on this
 * CLI/daemon package, can construct the `config` field of an `agent:wake`
 * `HostCommand` — see `plans/community-agent-cli-bridge.md` §1 and
 * `plans/minimal-wake-queue-unread-notice.md`). Re-exported here so existing
 * daemon call sites keep importing from `./runtimeConfig.js` unchanged.
 *
 * This file keeps `resolveLaunchFields`/`ResolvedLaunchFields` — daemon-only,
 * host-side resolution of a `RuntimeConfig` into flat launch fields (CLI args +
 * env) that each driver consumes. Config is start-time: changing it means
 * relaunching the agent with a new RuntimeConfig (there is no live-reconfigure
 * path — model/effort are spawn-time args).
 */

export {
  RUNTIME_CONFIG_VERSION,
  makeRuntimeConfig,
} from "@alook/shared/runtime-config";
export type {
  ReasoningEffort,
  ModelConfig,
  ProviderConfig,
  ModeConfig,
  RuntimeConfig,
} from "@alook/shared/runtime-config";

import type { ReasoningEffort, RuntimeConfig } from "@alook/shared/runtime-config";

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
