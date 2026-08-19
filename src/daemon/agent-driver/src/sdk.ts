import type {
  AgentDriverSdk,
  BuiltinBackendId,
  BuiltinBackendSpecs,
  CreateAgentDriverSdkOptions,
  OpenSessionInput,
  OpenSessionResult,
  ProbeInput,
  BackendProbe,
  CapabilitiesOf,
} from "./contract.js";
import { createDefaultAgentDriverHost } from "./host/default-host.js";
import { BUILTIN_BACKEND_IDS, capabilitiesFor } from "./registry.js";
import { createAdapter } from "./internal/createAdapter.js";
import { LogicalAgentSession } from "./controller/logical-session.js";

export function createAgentDriverSdk(
  options: CreateAgentDriverSdkOptions = {},
): AgentDriverSdk<BuiltinBackendSpecs> {
  const host = options.host ?? createDefaultAgentDriverHost();
  const hostReleaseTimeoutMs = options.hostReleaseTimeoutMs ?? 5_000;
  return {
    backendIds: BUILTIN_BACKEND_IDS,
    async probe<Id extends BuiltinBackendId>(
      input: ProbeInput<BuiltinBackendSpecs, Id>,
    ): Promise<BackendProbe<CapabilitiesOf<BuiltinBackendSpecs, Id>>> {
      const adapter = createAdapter(input.backend);
      const capabilities = capabilitiesFor(input.backend);
      try {
        const result = await adapter.probe(input.command);
        if (result.status === "healthy") {
          return { status: "healthy", version: result.version, capabilities };
        }
        return {
          status: "unhealthy",
          error: {
            category: "runtime_unavailable",
            code: result.lastError ?? "probe_failed",
            message: `Backend ${input.backend} is unavailable`,
            retryable: true,
          },
          capabilities,
        };
      } catch (error) {
        return {
          status: "unhealthy",
          error: {
            category: "runtime_unavailable",
            code: "probe_threw",
            message: String(error),
            retryable: true,
          },
          capabilities,
        };
      }
    },
    async open<Id extends BuiltinBackendId>(
      input: OpenSessionInput<BuiltinBackendSpecs, Id>,
    ): Promise<OpenSessionResult<BuiltinBackendSpecs, Id>> {
      const prepared = await host.prepareExecution({
        backend: input.backend,
        launchId: input.launch.launchId,
        workingDirectory: input.launch.workingDirectory,
      });
      if (!prepared.ok) return prepared;
      const session = new LogicalAgentSession(
        input.backend,
        input.config,
        {
          workingDirectory: input.launch.workingDirectory,
          instructions: input.launch.instructions.content,
          resumeSessionId: input.launch.resumeSessionId,
          launchId: input.launch.launchId,
        },
        createAdapter(input.backend),
        host,
        prepared.resource,
        hostReleaseTimeoutMs,
      );
      return { ok: true, session, capabilities: capabilitiesFor(input.backend) };
    },
  };
}
