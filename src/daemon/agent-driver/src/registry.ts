import type {
  BackendCapabilities,
  BuiltinBackendId,
  BuiltinBackendSpecs,
  CapabilitiesOf,
} from "./contract.js";

export const BUILTIN_BACKEND_IDS = ["claude", "codex", "cursor", "opencode", "pi"] as const;

const capabilities = {
  claude: {
    modelSelection: "launchable",
    providerConfiguration: true,
    reasoningEffort: true,
    fastMode: true,
    disallowedTools: true,
    commandOverride: true,
    resume: "by_id",
    midTurnDelivery: "safe_boundary_queue",
    interrupt: true,
  },
  codex: {
    modelSelection: "launchable",
    providerConfiguration: false,
    reasoningEffort: true,
    fastMode: true,
    disallowedTools: false,
    commandOverride: true,
    resume: "by_id",
    midTurnDelivery: "safe_boundary_queue",
    interrupt: true,
  },
  cursor: {
    modelSelection: "launchable",
    providerConfiguration: false,
    reasoningEffort: false,
    fastMode: false,
    disallowedTools: false,
    commandOverride: true,
    resume: "by_id",
    midTurnDelivery: "next_turn_queue",
    interrupt: true,
  },
  opencode: {
    modelSelection: "launchable",
    providerConfiguration: false,
    reasoningEffort: false,
    fastMode: false,
    disallowedTools: false,
    commandOverride: true,
    resume: "by_id",
    midTurnDelivery: "next_turn_queue",
    interrupt: true,
  },
  pi: {
    modelSelection: "launchable",
    providerConfiguration: true,
    reasoningEffort: true,
    fastMode: false,
    disallowedTools: false,
    commandOverride: true,
    resume: "by_id",
    midTurnDelivery: "steer",
    interrupt: true,
  },
} as const satisfies Record<BuiltinBackendId, BackendCapabilities>;

export function capabilitiesFor<Id extends BuiltinBackendId>(
  backend: Id,
): CapabilitiesOf<BuiltinBackendSpecs, Id> {
  return capabilities[backend] as CapabilitiesOf<BuiltinBackendSpecs, Id>;
}
