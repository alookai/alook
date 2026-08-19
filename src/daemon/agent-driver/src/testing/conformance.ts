import type {
  AgentSession,
  BuiltinBackendId,
  BuiltinBackendSpecs,
  DeliveryReceipt,
  StopReceipt,
} from "../contract.js";

export interface AgentDriverConformanceFixture<Id extends BuiltinBackendId> {
  readonly session: AgentSession<BuiltinBackendSpecs, Id>;
  completeFirstTurn(): Promise<void>;
}

export interface AgentDriverConformanceResult {
  readonly sendBeforeStart: DeliveryReceipt;
  readonly firstStart: DeliveryReceipt;
  readonly duplicateStart: DeliveryReceipt;
  readonly conflictingDuplicate: DeliveryReceipt;
  readonly secondStart: DeliveryReceipt;
  readonly stop: StopReceipt;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Agent-driver conformance failed: ${message}`);
}

/**
 * Reusable black-box receipt/idempotency suite for third-party adapter authors.
 * The fixture supplies only a public session and a deterministic way to finish
 * its first turn; the suite does not reach into adapter internals.
 */
export async function runAgentDriverConformance<Id extends BuiltinBackendId>(
  create: () => Promise<AgentDriverConformanceFixture<Id>> | AgentDriverConformanceFixture<Id>,
): Promise<AgentDriverConformanceResult> {
  const fixture = await create();
  const { session } = fixture;
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
  return { sendBeforeStart, firstStart, duplicateStart, conflictingDuplicate, secondStart, stop };
}
