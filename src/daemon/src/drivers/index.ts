import {
  BUILTIN_BACKEND_IDS,
  createAgentDriverSdk,
  getBuiltinBackendCapabilities,
  type BackendCapabilities,
  type BuiltinBackendId,
} from "@alook/agent-driver";

export type RuntimeId = BuiltinBackendId;

export interface AgentBackend {
  readonly id: RuntimeId;
  readonly capabilities: BackendCapabilities;
  probe(): ReturnType<ReturnType<typeof createAgentDriverSdk>["probe"]>;
}

export function getDriver(runtimeId: string): AgentBackend {
  if (!(BUILTIN_BACKEND_IDS as readonly string[]).includes(runtimeId)) {
    throw new Error(`Unknown runtime: ${runtimeId}. Available: ${BUILTIN_BACKEND_IDS.join(", ")}`);
  }
  const id = runtimeId as RuntimeId;
  return {
    id,
    capabilities: getBuiltinBackendCapabilities(id),
    probe: () => createAgentDriverSdk().probe({ backend: id }),
  };
}

export function listRuntimeIds(): RuntimeId[] {
  return [...BUILTIN_BACKEND_IDS];
}
