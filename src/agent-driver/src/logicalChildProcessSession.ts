import {
  AgentDriverLogicalSession,
  type AgentDriverLogicalSessionOptions,
} from "./session.js";
import type { AgentDriverRuntimeTerminalEvent } from "./contracts.js";

export interface AgentDriverPhysicalTurnSettlement {
  readonly turnId: string;
  readonly exit: "natural" | "terminate_on_turn_result";
  readonly terminal: AgentDriverRuntimeTerminalEvent;
}

export interface AgentDriverLogicalChildProcessSessionOptions
  extends Omit<AgentDriverLogicalSessionOptions, "settleTurn"> {
  readonly settlePhysicalTurn?: (settlement: AgentDriverPhysicalTurnSettlement) => void | Promise<void>;
}

function logicalOptions(
  options: AgentDriverLogicalChildProcessSessionOptions,
): AgentDriverLogicalSessionOptions {
  if (options.descriptor.transport.kind !== "child_process") {
    throw new TypeError("AgentDriverLogicalChildProcessSession requires a child_process descriptor");
  }
  const lifecycle = options.descriptor.lifecycle;
  if (lifecycle.kind === "per_turn" && !options.settlePhysicalTurn) {
    throw new TypeError("A per_turn child-process session requires settlePhysicalTurn");
  }
  return {
    ...options,
    settleTurn: lifecycle.kind === "per_turn"
      ? ({ turnId, terminal }) => options.settlePhysicalTurn!({ turnId, terminal, exit: lifecycle.exit })
      : undefined,
  };
}

/** Logical session core for JSONL/JSON-RPC child-process drivers. */
export class AgentDriverLogicalChildProcessSession extends AgentDriverLogicalSession {
  constructor(options: AgentDriverLogicalChildProcessSessionOptions) {
    super(logicalOptions(options));
  }
}
