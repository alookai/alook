/** Stable host-integration boundary for daemon/runtime embedders. */
export type * from "./public-contract.js";
export { createAgentDriverSdk as createBuiltinAgentDriverSdk } from "./sdk.js";
export { createDefaultAgentDriverHost } from "./host/default-host.js";
export { readBuiltinProviderQuota, supportsBuiltinQuotaPolling } from "./provider-quota.js";
export { scrubDriverErrorMessage as scrubAgentDriverDiagnosticText } from "./internal/errors.js";
export { killProcessTree as stopOwnedProcessTree } from "./internal/killTree.js";
export { macosAgentLauncher } from "./internal/macos-agent-launch.js";
export type {
  AgentDriverHost,
  CreateAgentDriverSdkOptions,
  DefaultAgentDriverHostOptions,
  PrepareExecutionInput,
  PrepareExecutionResult,
  PreparedExecutionResource,
  RawOutputEvent,
} from "./contract.js";
