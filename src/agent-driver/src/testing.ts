import {
  AgentDriverContractError,
  type AgentDriverEvent,
  type AgentDriverSession,
} from "./contracts.js";

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
