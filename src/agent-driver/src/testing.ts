import {
  AgentDriverContractError,
  validateAgentDriverDescriptor,
  type AgentDriver,
  type AgentDriverEvent,
  type AgentDriverLaunch,
  type AgentDriverPrompt,
  type AgentDriverReceipt,
  type AgentDriverSession,
} from "./contracts.js";
import type { AgentDriverHost } from "./host.js";

export interface AgentDriverSessionContractFixture {
  readonly session: AgentDriverSession;
  readonly cleanupStarted: Promise<void>;
  emitLateEvent(event: AgentDriverEvent): void;
  releaseCleanup(): void;
}

function contractViolation(message: string): never {
  throw new AgentDriverContractError("invalid_session_contract", message);
}

export async function verifyAgentDriverSessionContract(
  fixture: AgentDriverSessionContractFixture,
): Promise<void> {
  const observed: AgentDriverEvent[] = [];
  fixture.session.subscribe((event) => observed.push(event));
  const first = fixture.session.close({ reason: "contract-test", forceAfterMs: 60_000 });
  if (!fixture.session.closed) contractViolation("close() must make the session logically closed synchronously");
  const second = fixture.session.close({ force: true });
  if (second !== first) contractViolation("repeated close() calls must share one Promise");

  await fixture.cleanupStarted;
  fixture.emitLateEvent({ kind: "diagnostic", source: "contract-test", message: "late" });
  if (observed.length !== 0) contractViolation("listeners must be quiescent once close() starts");
  fixture.releaseCleanup();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  if (firstResult !== secondResult) contractViolation("repeated close() calls must share one result object");
  if (firstResult.status !== "closed" || firstResult.forced) {
    contractViolation("graceful cleanup must report one non-forced closed result");
  }
}

export interface AgentDriverConformanceFixture<THost extends AgentDriverHost = AgentDriverHost> {
  readonly driver: AgentDriver<THost>;
  readonly launch: AgentDriverLaunch<THost>;
  readonly firstPrompt: AgentDriverPrompt;
}

export interface AgentDriverConformanceResult {
  readonly receipt: AgentDriverReceipt;
  readonly events: readonly AgentDriverEvent[];
}

/** Reusable black-box contract harness for external and built-in drivers. */
export async function verifyAgentDriverConformance<THost extends AgentDriverHost>(
  fixture: AgentDriverConformanceFixture<THost>,
): Promise<AgentDriverConformanceResult> {
  validateAgentDriverDescriptor(fixture.driver.descriptor);
  const session = await fixture.driver.open(fixture.launch);
  const events: AgentDriverEvent[] = [];
  session.subscribe((event) => events.push(event));
  const receipt = await session.deliver(fixture.firstPrompt);
  if (!receipt.accepted || receipt.delivery !== "prompt" || !receipt.turnId) {
    contractViolation("first concrete delivery must start and bind one physical turn");
  }
  const starts = events.filter((event) => event.kind === "turn_started" && event.turnId === receipt.turnId);
  const bindings = events.filter(
    (event) => event.kind === "delivery_bound"
      && event.turnId === receipt.turnId
      && event.deliveryId === fixture.firstPrompt.deliveryId,
  );
  if (starts.length !== 1) contractViolation("a physical turn must publish turn_started exactly once");
  if (bindings.length !== 1) contractViolation("a delivery must bind to its physical turn exactly once");
  if (events.indexOf(starts[0]!) > events.indexOf(bindings[0]!)) {
    contractViolation("turn_started must precede its first delivery binding");
  }
  const firstClose = session.close({ reason: "conformance", forceAfterMs: 60_000 });
  const secondClose = session.close({ force: true });
  if (firstClose !== secondClose) contractViolation("driver close must be idempotent");
  await firstClose;
  return { receipt, events };
}
