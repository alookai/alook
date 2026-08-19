import type { AgentDriverSdk, BuiltinBackendSpecs } from "./contract.js";
import { createAgentDriverSdk as createBuiltinSdk } from "./sdk.js";

export interface PublicAgentDriverSdkOptions {
  readonly hostReleaseTimeoutMs?: number;
}

export function createAgentDriverSdk(
  options: PublicAgentDriverSdkOptions = {},
): AgentDriverSdk<BuiltinBackendSpecs> {
  return createBuiltinSdk(options);
}
