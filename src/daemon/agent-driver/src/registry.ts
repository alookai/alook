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
    assertRegistrationShape(registration);
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

function assertRegistrationShape(registration: unknown): void {
  if (!registration || typeof registration !== "object") throw new Error("Invalid agent backend registration");
  const candidate = registration as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new Error("Agent backend registration requires a non-empty id");
  }
  if (!candidate.capabilities || typeof candidate.capabilities !== "object") {
    throw new Error(`Agent backend registration ${candidate.id} requires capabilities`);
  }
  const capabilities = candidate.capabilities as Record<string, unknown>;
  const enumFields = {
    modelSelection: ["launchable", "unsupported"],
    resume: ["by_id", "none"],
    midTurnDelivery: ["safe_boundary_queue", "steer", "next_turn_queue"],
  } as const;
  for (const [field, allowed] of Object.entries(enumFields)) {
    if (!allowed.includes(String(capabilities[field]) as never)) {
      throw new Error(`Agent backend registration ${candidate.id} has invalid capability ${field}`);
    }
  }
  for (const field of [
    "providerConfiguration",
    "reasoningEffort",
    "fastMode",
    "disallowedTools",
    "commandOverride",
    "interrupt",
  ] as const) {
    if (typeof capabilities[field] !== "boolean") {
      throw new Error(`Agent backend registration ${candidate.id} has invalid capability ${field}`);
    }
  }
  if (typeof candidate.createAdapter !== "function") {
    throw new Error(`Agent backend registration ${candidate.id} requires createAdapter()`);
  }
}

export function assertAdapterCompatibility(
  registrationId: string,
  adapter: unknown,
): asserts adapter is BackendAdapter<string, unknown> {
  if (!adapter || typeof adapter !== "object") throw new Error(`Adapter ${registrationId} factory returned no adapter`);
  const candidate = adapter as Record<string, unknown>;
  if (candidate.id !== registrationId) {
    throw new Error(`Adapter identity mismatch for registration ${registrationId}`);
  }
  for (const method of ["probe", "normalizeLine", "encodeMessage"] as const) {
    if (typeof candidate[method] !== "function") throw new Error(`Adapter ${registrationId} is missing ${method}()`);
  }
  const instruction = candidate.instructionDelivery as Record<string, unknown> | undefined;
  if (!instruction || (instruction.kind !== "native" && instruction.kind !== "workspace_file")) {
    throw new Error(`Adapter ${registrationId} has an invalid instructionDelivery declaration`);
  }
  if (
    instruction.kind === "workspace_file"
    && (
      typeof instruction.canonical !== "string"
      || instruction.canonical.length === 0
      || !Array.isArray(instruction.aliases)
      || !instruction.aliases.every((alias) => typeof alias === "string")
    )
  ) {
    throw new Error(`Adapter ${registrationId} has an invalid workspace_file instruction declaration`);
  }
  const execution = candidate.execution as Record<string, unknown> | undefined;
  if (!execution || !["persistent_process", "per_turn_process", "in_process_sdk"].includes(String(execution.kind))) {
    throw new Error(`Adapter ${registrationId} has an invalid execution declaration`);
  }
  const executionValid = execution.kind === "persistent_process"
    ? execution.input === "direct" || execution.input === "safe_boundary"
    : execution.kind === "per_turn_process"
      ? (execution.start === "immediate" || execution.start === "deferred")
        && (execution.afterTurn === "natural_exit" || execution.afterTurn === "terminate")
      : execution.input === "direct";
  if (!executionValid) throw new Error(`Adapter ${registrationId} has an incomplete execution declaration`);
  if (candidate.currentSessionId !== null && typeof candidate.currentSessionId !== "string") {
    throw new Error(`Adapter ${registrationId} has an invalid currentSessionId`);
  }
  const laneFactory = execution.kind === "in_process_sdk" ? "openSdkSession" : "spawn";
  if (typeof candidate[laneFactory] !== "function") {
    throw new Error(`Adapter ${registrationId} execution requires ${laneFactory}()`);
  }
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
