import { randomUUID } from "node:crypto";
import type {
  AgentDriverHost,
  DefaultAgentDriverHostOptions,
  PreparedExecutionResource,
} from "../contract.js";

export function createDefaultAgentDriverHost(
  options: DefaultAgentDriverHostOptions = {},
): AgentDriverHost {
  const environment = { ...(options.environment ?? process.env) };
  return {
    async prepareExecution() {
      const resource: PreparedExecutionResource = {
        environmentLayers: {
          base: environment,
          hostStatic: {},
          identityProtected: {},
          platformProtected: {},
          runtimeProtected: {},
          networkProtected: {},
          credentialSensitive: {},
        },
        async release() {},
      };
      return { ok: true, resource };
    },
    onRawOutput(event) {
      options.onRawOutput?.(event);
    },
    now: () => Date.now(),
    createId: () => randomUUID(),
  };
}
