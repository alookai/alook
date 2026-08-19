import type { AgentDriverHost } from "./host.js";

export const AGENT_RUNTIME_IDS = ["claude", "codex", "cursor", "opencode", "pi"] as const;
export const AGENT_DRIVER_CONTRACT_VERSION = 1 as const;

export type AgentRuntimeId = (typeof AGENT_RUNTIME_IDS)[number];

export type AgentDriverLifecycle =
  | {
      readonly kind: "persistent";
      readonly busyDelivery: "direct_steer" | "gated_steer_coalesce";
    }
  | {
      readonly kind: "per_turn";
      readonly start: "immediate" | "defer_until_concrete";
      readonly exit: "natural" | "terminate_on_turn_result";
      readonly busyDelivery: "coalesce_next_turn";
    };

export type AgentDriverTransport =
  | {
      readonly kind: "child_process";
      readonly protocol: "jsonl" | "json_rpc";
    }
  | {
      readonly kind: "sdk";
    };

export type AgentDriverResume =
  | {
      readonly kind: "by_id";
      readonly missingSession: "fresh" | "error" | "create_with_requested_id";
    }
  | {
      readonly kind: "none";
    };

export interface AgentDriverModelContract {
  readonly detectedModels: "launchable" | "suggestion_only";
  readonly selection: "supported" | "runtime_default_only";
}

export interface AgentDriverCapabilities {
  readonly reasoningEffort: boolean;
  readonly fastMode: boolean;
  readonly disallowedTools: boolean;
  readonly command: boolean;
  readonly nativeStandingPrompt: boolean;
}

export interface AgentDriverDescriptor {
  readonly contractVersion: typeof AGENT_DRIVER_CONTRACT_VERSION;
  readonly id: AgentRuntimeId;
  readonly displayName: string;
  readonly lifecycle: AgentDriverLifecycle;
  readonly transport: AgentDriverTransport;
  readonly terminal: {
    readonly source: "protocol_event";
    readonly processExit: "abort_active_turn";
  };
  readonly resume: AgentDriverResume;
  readonly model: AgentDriverModelContract;
  readonly capabilities: AgentDriverCapabilities;
}

export interface AgentDriverRuntimeConfig {
  readonly model?: string;
  readonly provider?: string;
  readonly mode?: string;
  readonly reasoningEffort?: "low" | "medium" | "high";
  readonly fastMode?: boolean;
  readonly disallowedTools?: string;
  readonly command?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface AgentDriverIdentity {
  readonly agentId: string;
  readonly agentName?: string;
  readonly agentHandle?: string;
  readonly ownerHandle?: string;
}

export interface AgentDriverLaunch<THost extends AgentDriverHost = AgentDriverHost> {
  readonly identity: AgentDriverIdentity;
  readonly workingDirectory: string;
  readonly standingPrompt: string;
  readonly signal: AbortSignal;
  readonly resumeSessionId?: string;
  readonly runtimeConfig: AgentDriverRuntimeConfig;
  readonly host: THost;
}

export interface AgentDriverPrompt {
  readonly deliveryId: string;
  readonly text: string;
  readonly mode: "initial" | "idle" | "busy";
  readonly intent: "user" | "control";
  readonly execution: "concrete" | "bookkeeping";
}

export type AgentDriverReceipt =
  | {
      readonly accepted: true;
      readonly deliveryId: string;
      readonly delivery: "prompt" | "steer";
      readonly turnId: string;
    }
  | {
      readonly accepted: true;
      readonly deliveryId: string;
      readonly delivery: "pending_gated" | "queued_next_turn" | "deferred_bookkeeping";
    }
  | {
      readonly accepted: false;
      readonly deliveryId: string;
      readonly reason: "closed" | "unsupported" | "runtime_error" | "duplicate_delivery_conflict";
      readonly message?: string;
    };

export type AgentDriverDeliveryResult =
  | {
      readonly status: "clean";
      readonly deliveryId: string;
      readonly turnId: string;
      readonly sessionId?: string;
    }
  | {
      readonly status: "error";
      readonly deliveryId: string;
      readonly turnId?: string;
      readonly sessionId?: string;
      readonly message: string;
      readonly code?: string;
      readonly retryable?: boolean;
    }
  | {
      readonly status: "aborted";
      readonly deliveryId: string;
      readonly turnId?: string;
      readonly sessionId?: string;
      readonly reason: string;
    };

export interface AgentDriverCorrelatedTurnEventScope {
  readonly turnId: string;
}

export interface AgentDriverSessionEventScope {
  readonly turnId?: string;
}

export type AgentDriverTurnResult =
  | {
      readonly status: "clean";
      readonly turnId: string;
      readonly deliveryIds: readonly string[];
      readonly sessionId?: string;
    }
  | {
      readonly status: "error";
      readonly turnId: string;
      readonly deliveryIds: readonly string[];
      readonly sessionId?: string;
      readonly message: string;
      readonly code?: string;
      readonly retryable?: boolean;
    }
  | {
      readonly status: "aborted";
      readonly turnId: string;
      readonly deliveryIds: readonly string[];
      readonly sessionId?: string;
      readonly reason: string;
    };

export type AgentDriverEvent =
  | { readonly kind: "session"; readonly phase: "opened" | "resumed"; readonly sessionId: string }
  | { readonly kind: "turn_started"; readonly turnId: string; readonly deliveryIds: readonly string[]; readonly sessionId?: string }
  | { readonly kind: "delivery_bound"; readonly deliveryId: string; readonly turnId: string }
  | (AgentDriverCorrelatedTurnEventScope & { readonly kind: "thinking"; readonly text: string })
  | (AgentDriverCorrelatedTurnEventScope & { readonly kind: "text"; readonly text: string })
  | (AgentDriverCorrelatedTurnEventScope & { readonly kind: "tool_call"; readonly toolCallId: string; readonly name: string; readonly input: unknown })
  | (AgentDriverCorrelatedTurnEventScope & { readonly kind: "tool_result"; readonly toolCallId: string; readonly name: string; readonly output?: unknown; readonly isError?: boolean })
  | (AgentDriverCorrelatedTurnEventScope & { readonly kind: "compaction"; readonly phase: "started" | "finished" })
  | (AgentDriverCorrelatedTurnEventScope & { readonly kind: "review"; readonly phase: "started" | "finished" })
  | (AgentDriverSessionEventScope & { readonly kind: "progress"; readonly source?: string; readonly itemType?: string; readonly payloadBytes?: number })
  | (AgentDriverSessionEventScope & { readonly kind: "diagnostic"; readonly severity?: string; readonly source?: string; readonly message: string })
  | (AgentDriverSessionEventScope & { readonly kind: "telemetry"; readonly name: "token_usage" | "rate_limits"; readonly source: string; readonly attributes: Readonly<Record<string, unknown>> })
  | { readonly kind: "delivery_result"; readonly result: AgentDriverDeliveryResult }
  | { readonly kind: "turn_result"; readonly result: AgentDriverTurnResult };

export type AgentDriverRuntimeEvent =
  | { readonly kind: "session"; readonly phase: "opened" | "resumed"; readonly sessionId: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool_call"; readonly toolCallId: string; readonly name: string; readonly input: unknown }
  | { readonly kind: "tool_result"; readonly toolCallId: string; readonly name: string; readonly output?: unknown; readonly isError?: boolean }
  | { readonly kind: "compaction"; readonly phase: "started" | "finished" }
  | { readonly kind: "review"; readonly phase: "started" | "finished" }
  | { readonly kind: "progress"; readonly source?: string; readonly itemType?: string; readonly payloadBytes?: number }
  | { readonly kind: "diagnostic"; readonly severity?: string; readonly source?: string; readonly message: string }
  | { readonly kind: "telemetry"; readonly name: "token_usage" | "rate_limits"; readonly source: string; readonly attributes: Readonly<Record<string, unknown>> }
  | { readonly kind: "turn_terminal"; readonly status: "clean"; readonly sessionId?: string }
  | { readonly kind: "turn_terminal"; readonly status: "error"; readonly sessionId?: string; readonly message: string; readonly code?: string; readonly retryable?: boolean }
  | { readonly kind: "turn_terminal"; readonly status: "aborted"; readonly sessionId?: string; readonly reason: string };

export type AgentDriverRuntimeTerminalEvent = Extract<AgentDriverRuntimeEvent, { kind: "turn_terminal" }>;
export type AgentDriverRuntimeSessionEvent = Extract<
  AgentDriverRuntimeEvent,
  { kind: "session" | "progress" | "diagnostic" | "telemetry" }
>;
export type AgentDriverRuntimeTurnEvent = Exclude<AgentDriverRuntimeEvent, { kind: "session" }>;

export type AgentDriverEventListener = (event: AgentDriverEvent) => void;

export type AgentDriverCleanupResult =
  | { readonly status: "closed"; readonly forced: false }
  | { readonly status: "closed"; readonly forced: true; readonly forceReason: "requested" | "deadline" }
  | { readonly status: "failed"; readonly forced: boolean; readonly message: string };

export interface AgentDriverCloseOptions {
  readonly reason?: string;
  readonly forceAfterMs?: number;
  readonly force?: boolean;
}

export interface AgentDriverSession {
  readonly sessionId: string | null;
  readonly closed: boolean;
  subscribe(listener: AgentDriverEventListener): () => void;
  deliver(prompt: AgentDriverPrompt): Promise<AgentDriverReceipt>;
  close(options?: AgentDriverCloseOptions): Promise<AgentDriverCleanupResult>;
}

export type AgentDriverProbeResult =
  | { readonly status: "healthy"; readonly version?: string }
  | { readonly status: "unhealthy"; readonly reason: string; readonly version?: string };

export interface AgentDriver<THost extends AgentDriverHost = AgentDriverHost> {
  readonly descriptor: AgentDriverDescriptor;
  probe(host: THost): Promise<AgentDriverProbeResult>;
  open(launch: AgentDriverLaunch<THost>): Promise<AgentDriverSession>;
}

export type AgentDriverContractErrorCode =
  | "unsupported_runtime"
  | "unsupported_contract_version"
  | "invalid_descriptor"
  | "invalid_session_contract"
  | "duplicate_runtime"
  | "runtime_not_registered";

export class AgentDriverContractError extends Error {
  constructor(
    readonly code: AgentDriverContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentDriverContractError";
  }
}

const runtimeIds = new Set<string>(AGENT_RUNTIME_IDS);

export function isAgentRuntimeId(value: unknown): value is AgentRuntimeId {
  return typeof value === "string" && runtimeIds.has(value);
}

export function assertAgentRuntimeId(value: unknown): AgentRuntimeId {
  if (!isAgentRuntimeId(value)) {
    throw new AgentDriverContractError(
      "unsupported_runtime",
      `Unsupported agent runtime: ${String(value)}. Supported: ${AGENT_RUNTIME_IDS.join(", ")}`,
    );
  }
  return value;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentDriverContractError("invalid_descriptor", `${field} must be a non-empty string`);
  }
}

function assertBooleanRecord(value: unknown, field: string): void {
  if (!value || typeof value !== "object") {
    throw new AgentDriverContractError("invalid_descriptor", `${field} must be an object`);
  }
  for (const key of ["reasoningEffort", "fastMode", "disallowedTools", "command", "nativeStandingPrompt"] as const) {
    if (typeof (value as Record<string, unknown>)[key] !== "boolean") {
      throw new AgentDriverContractError("invalid_descriptor", `${field}.${key} must be a boolean`);
    }
  }
}

function oneOf(value: unknown, values: readonly string[], field: string): void {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new AgentDriverContractError("invalid_descriptor", `${field} must be one of: ${values.join(", ")}`);
  }
}

export function validateAgentDriverDescriptor(value: unknown): asserts value is AgentDriverDescriptor {
  if (!value || typeof value !== "object") {
    throw new AgentDriverContractError("invalid_descriptor", "descriptor must be an object");
  }
  const descriptor = value as Record<string, unknown>;
  if (descriptor.contractVersion !== AGENT_DRIVER_CONTRACT_VERSION) {
    throw new AgentDriverContractError(
      "unsupported_contract_version",
      `Unsupported agent driver contract version: ${String(descriptor.contractVersion)}. Expected: ${AGENT_DRIVER_CONTRACT_VERSION}`,
    );
  }
  assertAgentRuntimeId(descriptor.id);
  assertNonEmptyString(descriptor.displayName, "descriptor.displayName");

  const lifecycle = descriptor.lifecycle as Record<string, unknown> | undefined;
  oneOf(lifecycle?.kind, ["persistent", "per_turn"], "descriptor.lifecycle.kind");
  if (lifecycle?.kind === "persistent") {
    oneOf(lifecycle.busyDelivery, ["direct_steer", "gated_steer_coalesce"], "descriptor.lifecycle.busyDelivery");
  } else {
    oneOf(lifecycle?.start, ["immediate", "defer_until_concrete"], "descriptor.lifecycle.start");
    oneOf(lifecycle?.exit, ["natural", "terminate_on_turn_result"], "descriptor.lifecycle.exit");
    oneOf(lifecycle?.busyDelivery, ["coalesce_next_turn"], "descriptor.lifecycle.busyDelivery");
  }

  const transport = descriptor.transport as Record<string, unknown> | undefined;
  oneOf(transport?.kind, ["child_process", "sdk"], "descriptor.transport.kind");
  if (transport?.kind === "child_process") {
    oneOf(transport.protocol, ["jsonl", "json_rpc"], "descriptor.transport.protocol");
  }

  const terminal = descriptor.terminal as Record<string, unknown> | undefined;
  oneOf(terminal?.source, ["protocol_event"], "descriptor.terminal.source");
  oneOf(terminal?.processExit, ["abort_active_turn"], "descriptor.terminal.processExit");

  const resume = descriptor.resume as Record<string, unknown> | undefined;
  oneOf(resume?.kind, ["by_id", "none"], "descriptor.resume.kind");
  if (resume?.kind === "by_id") {
    oneOf(resume.missingSession, ["fresh", "error", "create_with_requested_id"], "descriptor.resume.missingSession");
  }

  const model = descriptor.model as Record<string, unknown> | undefined;
  oneOf(model?.detectedModels, ["launchable", "suggestion_only"], "descriptor.model.detectedModels");
  oneOf(model?.selection, ["supported", "runtime_default_only"], "descriptor.model.selection");
  assertBooleanRecord(descriptor.capabilities, "descriptor.capabilities");
}

export function defineAgentDriverDescriptor<const T extends AgentDriverDescriptor>(descriptor: T): Readonly<T> {
  validateAgentDriverDescriptor(descriptor);
  Object.freeze(descriptor.lifecycle);
  Object.freeze(descriptor.transport);
  Object.freeze(descriptor.terminal);
  Object.freeze(descriptor.resume);
  Object.freeze(descriptor.model);
  Object.freeze(descriptor.capabilities);
  return Object.freeze(descriptor);
}
