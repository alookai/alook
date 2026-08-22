import type {
  AgentSession,
  AgentEvent,
  BackendId,
  DeliveryReceipt,
  StopReceipt,
} from "../contract.js";
import type { BackendAdapter, AdapterEvent } from "../internal/adapter.js";
import type { AgentBackendRegistration } from "../registry.js";

type NormalizingBackendAdapter<Id extends string, Config> = BackendAdapter<Id, Config> & {
  normalizeLine(line: string): AdapterEvent[];
};

export interface AgentDriverConformanceFixture<Specs, Id extends BackendId<Specs>> {
  readonly session: AgentSession<Specs, Id>;
  completeFirstTurn(): Promise<void>;
}

export interface AgentDriverConformanceResult {
  readonly sendBeforeStart: DeliveryReceipt;
  readonly firstStart: DeliveryReceipt;
  readonly duplicateStart: DeliveryReceipt;
  readonly conflictingDuplicate: DeliveryReceipt;
  readonly secondStart: DeliveryReceipt;
  readonly stop: StopReceipt;
  readonly events: readonly { readonly type: string; readonly sequence: number }[];
}

interface AgentBackendAdapterConformanceFixture<Id extends string, Config> {
  exercise(adapter: NormalizingBackendAdapter<Id, Config>): readonly AdapterEvent[];
  readonly expectedEventKinds: readonly AdapterEvent["kind"][];
  readonly terminalSource?: "normalized_event" | "transport_invocation";
}

/** Internal real-adapter contract runner; intentionally omitted from /testing. */
export function runAgentBackendAdapterConformance<Specs, Id extends BackendId<Specs>>(
  registration: AgentBackendRegistration<Specs, Id>,
  fixture: AgentBackendAdapterConformanceFixture<Id, import("../contract.js").ConfigOf<Specs, Id>>,
): readonly AdapterEvent[] {
  const first = registration.createAdapter() as NormalizingBackendAdapter<
    Id,
    import("../contract.js").ConfigOf<Specs, Id>
  >;
  const second = registration.createAdapter();
  assert(first !== second, "registry factory must return a fresh adapter instance");
  assert(first.id === registration.id, "registration and adapter ids must match");
  assert(
    first.instructionDelivery.kind === "native" || first.instructionDelivery.kind === "workspace_file",
    "adapter must declare an instruction-delivery strategy",
  );
  assert(
    first.execution.lifetime === "session" || first.execution.lifetime === "turn",
    "adapter must declare an execution strategy",
  );
  assert(typeof first.normalizeLine === "function", "built-in adapter must expose its internal event normalizer");

  const events = fixture.exercise(first);
  assert(
    JSON.stringify(events.map((event) => event.kind)) === JSON.stringify(fixture.expectedEventKinds),
    `normalized event order for ${registration.id} did not match the contract fixture`,
  );
  const terminalCount = events.filter((event) => event.kind === "turn_end").length;
  if (fixture.terminalSource === "transport_invocation") {
    assert(
      first.execution.terminalOwnership === "prompt_invocation",
      "transport-owned terminal requires prompt-invocation ownership",
    );
    assert(terminalCount === 0, "transport-owned terminal must not also come from an unowned vendor event payload");
  } else {
    assert(terminalCount === 1, "fixture must produce exactly one turn_end");
  }
  return events;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Agent-driver conformance failed: ${message}`);
}

/**
 * Reusable black-box receipt/idempotency suite for repository adapter
 * implementations.
 * The fixture supplies only a public session and a deterministic way to finish
 * its first turn; the suite does not reach into adapter internals.
 */
export async function runAgentDriverConformance<Specs, Id extends BackendId<Specs>>(
  create: () => Promise<AgentDriverConformanceFixture<Specs, Id>> | AgentDriverConformanceFixture<Specs, Id>,
): Promise<AgentDriverConformanceResult> {
  const fixture = await create();
  const { session } = fixture;
  const observed: AgentEvent<Specs, Id>[] = [];
  const collecting = (async () => {
    for await (const event of session.events) observed.push(event);
  })();
  const sendBeforeStart = await session.send({ id: "conformance-early", kind: "user", text: "early" });
  assert(sendBeforeStart.status === "rejected" && sendBeforeStart.reason === "not_started", "send before start must reject");

  const firstPromise = session.start({ id: "conformance-first", kind: "user", text: "hello" });
  const duplicatePromise = session.start({ id: "conformance-first", kind: "user", text: "hello" });
  const [firstStart, duplicateStart] = await Promise.all([firstPromise, duplicatePromise]);
  assert(JSON.stringify(firstStart) === JSON.stringify(duplicateStart), "byte-identical duplicate must replay its receipt");
  assert(firstStart.status === "accepted" || firstStart.status === "queued", "first start must be admitted");

  const conflictingDuplicate = await session.start({ id: "conformance-first", kind: "user", text: "different" });
  assert(conflictingDuplicate.status === "rejected" && conflictingDuplicate.reason === "duplicate_conflict", "conflicting duplicate must reject");
  const secondStart = await session.start({ id: "conformance-second", kind: "user", text: "second" });
  assert(secondStart.status === "rejected" && secondStart.reason === "already_started", "second start must reject");

  await fixture.completeFirstTurn();
  const stop = await session.stop({ reason: "shutdown", forceAfterMs: 100 });
  assert(stop.status === "accepted" || stop.status === "closed", "stop must settle truthfully");
  await session.closed;
  await collecting;

  const coreObserved = observed as unknown as Array<{
    readonly type: string;
    readonly sequence: number;
    readonly commandId?: string;
  }>;
  const firstCommandId = "conformance-first";
  const commandOutcomes = coreObserved.filter((event) =>
    ["command_accepted", "command_failed"].includes(event.type)
    && event.commandId === firstCommandId);
  assert(commandOutcomes.length === 1, "first command must have exactly one final admission outcome");
  const acceptedIndex = coreObserved.findIndex((event) => event.type === "command_accepted" && event.commandId === firstCommandId);
  const startedIndex = coreObserved.findIndex((event) => event.type === "turn_started");
  const completedIndex = coreObserved.findIndex((event) => event.type === "turn_completed");
  const closedIndex = coreObserved.findIndex((event) => event.type === "session_closed");
  assert(acceptedIndex >= 0 && startedIndex > acceptedIndex, "command acceptance must precede turn_started");
  assert(completedIndex > startedIndex, "turn_completed must follow turn_started");
  assert(closedIndex > completedIndex && closedIndex === coreObserved.length - 1, "session_closed must be the final event");
  for (let index = 0; index < coreObserved.length; index += 1) {
    assert(coreObserved[index]!.sequence === index + 1, "event sequence must be contiguous and monotonic");
  }

  return {
    sendBeforeStart,
    firstStart,
    duplicateStart,
    conflictingDuplicate,
    secondStart,
    stop,
    events: coreObserved,
  };
}
