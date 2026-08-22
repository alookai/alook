import type { BuiltinBackendId, PreparedExecutionResource } from "../contract.js";
import type { AdapterLaunchContext } from "../internal/adapter.js";

export function fakePrepared(
  overrides: Partial<PreparedExecutionResource["environmentLayers"]> = {},
): PreparedExecutionResource {
  return {
    environmentLayers: {
      base: {},
      hostStatic: {},
      identityProtected: {},
      platformProtected: {},
      runtimeProtected: {},
      networkProtected: {},
      credentialSensitive: {},
      ...overrides,
    },
    release: async () => {},
  };
}

export function fakeLaunchContext(
  backend: BuiltinBackendId,
  workingDirectory: string,
  overrides: Partial<AdapterLaunchContext> = {},
): AdapterLaunchContext {
  return {
    backend,
    agentId: "agent_1",
    launchId: "launch_1",
    workingDirectory,
    standingPrompt: "",
    prompt: "",
    prepared: fakePrepared(),
    config: {},
    ...overrides,
  };
}
