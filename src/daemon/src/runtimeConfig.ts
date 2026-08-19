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
 * The daemon only translates the shared wire shape into the public agent-driver
 * contract and projects backend-neutral display fields. Backend launch/provider
 * interpretation belongs exclusively to `@alook/agent-driver`.
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

import type { RuntimeConfig } from "@alook/shared/runtime-config";
import type {
  BuiltinBackendId,
  BuiltinBackendSpecs,
  ClaudeConfig,
  ConfigOf,
  PiConfig,
} from "@alook/agent-driver";

export type AgentBackendSelection = {
  [Id in BuiltinBackendId]: {
    backend: Id;
    config: ConfigOf<BuiltinBackendSpecs, Id>;
  };
}[BuiltinBackendId];

export function toAgentBackendSelection(config: RuntimeConfig): AgentBackendSelection {
  const model = config.model;
  const environment = config.envVars;
  const base = { model, command: config.command, environment };
  switch (config.runtime) {
    case "claude": {
      const provider: ClaudeConfig["provider"] = config.provider?.kind === "custom"
        ? { kind: "custom_endpoint", apiUrl: config.provider.apiUrl, apiKey: config.provider.apiKey }
        : { kind: "default" };
      return {
        backend: "claude",
        config: {
          ...base,
          provider,
          reasoningEffort: config.reasoningEffort,
          mode: config.mode.kind,
          disallowedTools: config.disallowedTools,
        },
      };
    }
    case "codex":
      return {
        backend: "codex",
        config: { ...base, reasoningEffort: config.reasoningEffort, mode: config.mode.kind },
      };
    case "cursor":
      return { backend: "cursor", config: base };
    case "opencode":
      return { backend: "opencode", config: base };
    case "pi": {
      const provider: PiConfig["provider"] = config.provider?.kind === "pi-builtin"
        ? {
            kind: "builtin",
            providerId: config.provider.providerId,
            apiKey: config.provider.apiKey,
          }
        : { kind: "default" };
      return {
        backend: "pi",
        config: { ...base, provider, reasoningEffort: config.reasoningEffort },
      };
    }
    default:
      throw new Error(`Unknown runtime: ${config.runtime}`);
  }
}

/** Backend-neutral projection used only for manager logs and trace metadata. */
export function runtimeModelName(config: RuntimeConfig | undefined): string | undefined {
  return config?.model.kind === "default" ? undefined : config?.model.name;
}
