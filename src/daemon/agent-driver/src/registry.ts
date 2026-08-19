import type {
  BackendCapabilities,
  BackendId,
  BuiltinBackendId,
  BuiltinBackendSpecs,
  CapabilitiesOf,
  ConfigOf,
} from "./contract.js";
import { ClaudeDriver } from "./adapters/claude/index.js";
import { CodexDriver } from "./adapters/codex/index.js";
import { CursorDriver } from "./adapters/cursor/index.js";
import { OpenCodeDriver } from "./adapters/opencode/index.js";
import { PiDriver } from "./adapters/pi/index.js";
import type { BackendAdapter } from "./internal/adapter.js";

export interface AgentBackendRegistration<Specs, Id extends BackendId<Specs>> {
  readonly id: Id;
  readonly capabilities: CapabilitiesOf<Specs, Id>;
  createAdapter(): BackendAdapter<Id, ConfigOf<Specs, Id>>;
}

export type AgentBackendRegistrationOf<Specs> = {
  [Id in BackendId<Specs>]: AgentBackendRegistration<Specs, Id>;
}[BackendId<Specs>];

export interface AgentDriverRegistry<Specs> {
  readonly backendIds: readonly BackendId<Specs>[];
  get<Id extends BackendId<Specs>>(id: Id): AgentBackendRegistration<Specs, Id>;
}

export function createAgentDriverRegistry<Specs>(
  registrations: readonly AgentBackendRegistrationOf<Specs>[],
): AgentDriverRegistry<Specs> {
  const entries = new Map<string, AgentBackendRegistrationOf<Specs>>();
  for (const registration of registrations) {
    if (entries.has(registration.id)) throw new Error(`Duplicate agent backend registration: ${registration.id}`);
    entries.set(registration.id, Object.freeze({ ...registration }));
  }
  const backendIds = Object.freeze([...entries.keys()]) as readonly BackendId<Specs>[];
  return Object.freeze({
    backendIds,
    get<Id extends BackendId<Specs>>(id: Id): AgentBackendRegistration<Specs, Id> {
      const registration = entries.get(id);
      if (!registration) throw new Error(`Unknown agent backend: ${id}`);
      return registration as AgentBackendRegistration<Specs, Id>;
    },
  });
}

export const BUILTIN_BACKEND_IDS = ["claude", "codex", "cursor", "opencode", "pi"] as const;

const capabilities = {
  claude: {
    modelSelection: "launchable", providerConfiguration: true, reasoningEffort: true, fastMode: true,
    disallowedTools: true, commandOverride: true, resume: "by_id", midTurnDelivery: "safe_boundary_queue", interrupt: true,
  },
  codex: {
    modelSelection: "launchable", providerConfiguration: false, reasoningEffort: true, fastMode: true,
    disallowedTools: false, commandOverride: true, resume: "by_id", midTurnDelivery: "safe_boundary_queue", interrupt: true,
  },
  cursor: {
    modelSelection: "launchable", providerConfiguration: false, reasoningEffort: false, fastMode: false,
    disallowedTools: false, commandOverride: true, resume: "by_id", midTurnDelivery: "next_turn_queue", interrupt: true,
  },
  opencode: {
    modelSelection: "launchable", providerConfiguration: false, reasoningEffort: false, fastMode: false,
    disallowedTools: false, commandOverride: true, resume: "by_id", midTurnDelivery: "next_turn_queue", interrupt: true,
  },
  pi: {
    modelSelection: "launchable", providerConfiguration: true, reasoningEffort: true, fastMode: false,
    disallowedTools: false, commandOverride: false, resume: "by_id", midTurnDelivery: "steer", interrupt: true,
  },
} as const satisfies Record<BuiltinBackendId, BackendCapabilities>;

export function createBuiltinAgentDriverRegistry(): AgentDriverRegistry<BuiltinBackendSpecs> {
  return createAgentDriverRegistry<BuiltinBackendSpecs>([
    { id: "claude", capabilities: capabilities.claude, createAdapter: () => new ClaudeDriver() },
    { id: "codex", capabilities: capabilities.codex, createAdapter: () => new CodexDriver() },
    { id: "cursor", capabilities: capabilities.cursor, createAdapter: () => new CursorDriver() },
    { id: "opencode", capabilities: capabilities.opencode, createAdapter: () => new OpenCodeDriver() },
    { id: "pi", capabilities: capabilities.pi, createAdapter: () => new PiDriver() },
  ]);
}

const builtinRegistry = createBuiltinAgentDriverRegistry();

export function capabilitiesFor<Id extends BuiltinBackendId>(
  backend: Id,
): CapabilitiesOf<BuiltinBackendSpecs, Id> {
  return builtinRegistry.get(backend).capabilities;
}
