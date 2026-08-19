/** Stable host-integration boundary for daemon/runtime embedders. */
export { createAgentDriverSdk as createBuiltinAgentDriverSdk } from "./sdk.js";
export { createDefaultAgentDriverHost } from "./host/default-host.js";
export { scrubDriverErrorMessage as scrubAgentDriverDiagnosticText } from "./internal/errors.js";
export type {
  AgentDriverHost,
  CreateAgentDriverSdkOptions,
  DefaultAgentDriverHostOptions,
  PreparedExecutionResource,
} from "./contract.js";
