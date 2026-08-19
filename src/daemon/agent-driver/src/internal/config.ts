import type {
  BackendConfig,
  AdapterLaunchConfig,
} from "./adapter.js";
import type {
  ClaudeProvider,
  PiProvider,
  ReasoningEffort,
} from "../contract.js";

interface ResolvedLaunchFields {
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  fastMode: boolean;
  command?: string;
  disallowedTools?: string;
  envVars: Record<string, string>;
  providerEnv: Record<string, string>;
}

const providerKeys: Record<string, string> = {
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const controlled = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  ...Object.values(providerKeys),
]);

export function resolveLaunchFieldsOrDefault(
  input: AdapterLaunchConfig | BackendConfig | undefined,
): ResolvedLaunchFields {
  const config: BackendConfig | undefined = input && "runtimeConfig" in input
    ? input.runtimeConfig
    : input as BackendConfig | undefined;
  if (!config) return { fastMode: false, envVars: {}, providerEnv: {} };
  const normalized = config as BackendConfig & {
    provider?: ClaudeProvider | PiProvider;
    reasoningEffort?: ReasoningEffort;
    disallowedTools?: string;
  };
  const envVars = Object.fromEntries(
    Object.entries(normalized.environment ?? {}).filter(([key]) => !controlled.has(key)),
  );
  const providerEnv: Record<string, string> = {};
  const model = normalized.model.kind === "default" ? undefined : normalized.model.name;
  if (normalized.model.kind === "custom" && normalized.provider?.kind === "custom_endpoint") {
    providerEnv.ANTHROPIC_CUSTOM_MODEL_OPTION = normalized.model.name;
  }
  if (normalized.provider?.kind === "custom_endpoint") {
    providerEnv.ANTHROPIC_BASE_URL = normalized.provider.apiUrl;
    providerEnv.ANTHROPIC_API_KEY = normalized.provider.apiKey;
  } else if (normalized.provider?.kind === "builtin") {
    const key = providerKeys[normalized.provider.providerId];
    if (key) providerEnv[key] = normalized.provider.apiKey;
  }
  return {
    model,
    reasoningEffort: normalized.reasoningEffort,
    fastMode: "mode" in normalized && normalized.mode === "fast",
    command: normalized.command,
    disallowedTools: normalized.disallowedTools,
    envVars,
    providerEnv,
  };
}
