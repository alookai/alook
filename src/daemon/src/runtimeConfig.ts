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
import {
  toBuiltinBackendSelection,
  type BuiltinBackendSelection,
} from "@alook/agent-driver";

export type AgentBackendSelection = BuiltinBackendSelection;

export function toAgentBackendSelection(config: RuntimeConfig): AgentBackendSelection {
  return toBuiltinBackendSelection(config);
}

/** Backend-neutral projection used only for manager logs and trace metadata. */
export function runtimeModelName(config: RuntimeConfig | undefined): string | undefined {
  return config?.model.kind === "default" ? undefined : config?.model.name;
}
