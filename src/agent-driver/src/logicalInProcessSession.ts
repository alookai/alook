import {
  AgentDriverLogicalSession,
  type AgentDriverLogicalSessionOptions,
} from "./session.js";

export type AgentDriverLogicalInProcessSessionOptions = Omit<AgentDriverLogicalSessionOptions, "settleTurn">;

/** Logical session core for in-process vendor SDK drivers. */
export class AgentDriverLogicalInProcessSession extends AgentDriverLogicalSession {
  constructor(options: AgentDriverLogicalInProcessSessionOptions) {
    super(options);
    if (options.descriptor.transport.kind !== "sdk") {
      throw new TypeError("AgentDriverLogicalInProcessSession requires an sdk descriptor");
    }
  }
}
