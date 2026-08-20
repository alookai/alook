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
  readonly contractVersion: 1;
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
  if (candidate.contractVersion !== 1) {
    throw new Error(`Agent backend registration ${candidate.id} has an unsupported adapter-author contract version`);
  }
  if (!candidate.capabilities || typeof candidate.capabilities !== "object") {
    throw new Error(`Agent backend registration ${candidate.id} requires capabilities`);
  }
  const capabilities = candidate.capabilities as Record<string, unknown>;
  const enumFields = {
    modelSelection: ["launchable", "suggestion_only", "unsupported"],
    resume: ["by_id", "none"],
    sessionLifetime: ["persistent", "per_turn"],
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
  registeredCapabilities: unknown,
  adapter: unknown,
): asserts adapter is BackendAdapter<string, unknown> {
  if (!adapter || typeof adapter !== "object") throw new Error(`Adapter ${registrationId} factory returned no adapter`);
  const candidate = adapter as Record<string, unknown>;
  if (candidate.id !== registrationId) {
    throw new Error(`Adapter identity mismatch for registration ${registrationId}`);
  }
  for (const method of ["probe", "openLane"] as const) {
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
  if (
    !execution
    || (execution.lifetime !== "session" && execution.lifetime !== "turn")
    || (execution.wakeStart !== "immediate" && execution.wakeStart !== "deferred")
    || !["transport_request", "vendor_message", "prompt_invocation", "lane_generation"]
      .includes(String(execution.terminalOwnership))
  ) {
    throw new Error(`Adapter ${registrationId} has an invalid execution declaration`);
  }
  const transport = execution.transport as Record<string, unknown> | undefined;
  if (
    !transport
    || typeof transport.kind !== "string"
    || transport.kind.trim().length === 0
    || typeof transport.protocol !== "string"
    || transport.protocol.trim().length === 0
    || (
      transport.metadata !== undefined
      && (
        !transport.metadata
        || typeof transport.metadata !== "object"
        || Array.isArray(transport.metadata)
      )
    )
  ) {
    throw new Error(`Adapter ${registrationId} has an invalid transport declaration`);
  }
  const capabilities = registeredCapabilities as Record<string, unknown> | undefined;
  const declaredLifetime = capabilities?.sessionLifetime === "persistent" ? "session" : "turn";
  if (execution.lifetime !== declaredLifetime) {
    throw new Error(`Adapter ${registrationId} lifetime conflicts with its registered capabilities`);
  }
  if (
    capabilities?.midTurnDelivery !== "next_turn_queue"
    && execution.lifetime !== "session"
  ) {
    throw new Error(`Adapter ${registrationId} delivery conflicts with its execution lifetime`);
  }
  if (execution.wakeStart === "deferred" && execution.lifetime !== "turn") {
    throw new Error(`Adapter ${registrationId} has an invalid deferred wake declaration`);
  }
}

export const BUILTIN_BACKEND_IDS = ["claude", "codex", "cursor", "opencode", "pi"] as const;

const capabilities = {
  claude: {
    modelSelection: "launchable", providerConfiguration: true, reasoningEffort: true, fastMode: true,
    disallowedTools: true, commandOverride: true, resume: "by_id", sessionLifetime: "persistent", midTurnDelivery: "safe_boundary_queue", interrupt: true,
  },
  codex: {
    modelSelection: "launchable", providerConfiguration: false, reasoningEffort: true, fastMode: true,
    disallowedTools: false, commandOverride: true, resume: "by_id", sessionLifetime: "persistent", midTurnDelivery: "safe_boundary_queue", interrupt: true,
  },
  cursor: {
    modelSelection: "launchable", providerConfiguration: false, reasoningEffort: false, fastMode: false,
    disallowedTools: false, commandOverride: true, resume: "by_id", sessionLifetime: "per_turn", midTurnDelivery: "next_turn_queue", interrupt: true,
  },
  opencode: {
    modelSelection: "launchable", providerConfiguration: false, reasoningEffort: false, fastMode: false,
    disallowedTools: false, commandOverride: true, resume: "by_id", sessionLifetime: "per_turn", midTurnDelivery: "next_turn_queue", interrupt: true,
  },
  pi: {
    modelSelection: "launchable", providerConfiguration: true, reasoningEffort: true, fastMode: false,
    disallowedTools: false, commandOverride: false, resume: "by_id", sessionLifetime: "persistent", midTurnDelivery: "steer", interrupt: true,
  },
} as const satisfies Record<BuiltinBackendId, BackendCapabilities>;

export function createBuiltinAgentDriverRegistry(): AgentDriverRegistry<BuiltinBackendSpecs> {
  return createAgentDriverRegistry<BuiltinBackendSpecs>([
    { id: "claude", contractVersion: 1, capabilities: capabilities.claude, createAdapter: () => new ClaudeDriver() },
    { id: "codex", contractVersion: 1, capabilities: capabilities.codex, createAdapter: () => new CodexDriver() },
    { id: "cursor", contractVersion: 1, capabilities: capabilities.cursor, createAdapter: () => new CursorDriver() },
    { id: "opencode", contractVersion: 1, capabilities: capabilities.opencode, createAdapter: () => new OpenCodeDriver() },
    { id: "pi", contractVersion: 1, capabilities: capabilities.pi, createAdapter: () => new PiDriver() },
  ]);
}

const builtinRegistry = createBuiltinAgentDriverRegistry();

export function capabilitiesFor<Id extends BuiltinBackendId>(
  backend: Id,
): CapabilitiesOf<BuiltinBackendSpecs, Id> {
  return builtinRegistry.get(backend).capabilities;
}
