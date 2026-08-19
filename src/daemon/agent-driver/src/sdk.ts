import type {
  AgentDriverSdk,
  BackendId,
  BackendProbe,
  BuiltinBackendSpecs,
  CapabilitiesOf,
  CreateAgentDriverSdkOptions,
  OpenSessionInput,
  OpenSessionResult,
  ProbeInput,
} from "./contract.js";
import { createDefaultAgentDriverHost } from "./host/default-host.js";
import { createBuiltinAgentDriverRegistry, type AgentDriverRegistry } from "./registry.js";
import { LogicalAgentSession } from "./controller/logical-session.js";
import { scrubDriverError, stableErrorCode } from "./internal/errors.js";

export function createAgentDriverSdk(
  options?: CreateAgentDriverSdkOptions<BuiltinBackendSpecs>,
): AgentDriverSdk<BuiltinBackendSpecs>;
export function createAgentDriverSdk<Specs>(
  options: CreateAgentDriverSdkOptions<Specs> & { readonly registry: AgentDriverRegistry<Specs> },
): AgentDriverSdk<Specs>;
export function createAgentDriverSdk<Specs = BuiltinBackendSpecs>(
  options: CreateAgentDriverSdkOptions<Specs> = {},
): AgentDriverSdk<Specs> {
  const host = options.host ?? createDefaultAgentDriverHost();
  const hostReleaseTimeoutMs = options.hostReleaseTimeoutMs ?? 5_000;
  const registry = options.registry
    ?? createBuiltinAgentDriverRegistry() as unknown as AgentDriverRegistry<Specs>;
  return {
    backendIds: registry.backendIds,
    async probe<Id extends BackendId<Specs>>(
      input: ProbeInput<Specs, Id>,
    ): Promise<BackendProbe<CapabilitiesOf<Specs, Id>>> {
      const registration = registry.get(input.backend);
      const capabilities = registration.capabilities;
      try {
        const command = (capabilities as { readonly commandOverride: boolean }).commandOverride
          ? input.command
          : undefined;
        const result = await registration.createAdapter().probe(command);
        if (result.status === "healthy") return { status: "healthy", version: result.version, capabilities };
        return {
          status: "unhealthy",
          error: {
            category: "runtime_unavailable",
            code: stableErrorCode(result.lastError, "probe_failed"),
            message: `Backend ${input.backend} is unavailable`,
            retryable: true,
          },
          capabilities,
        };
      } catch {
        return {
          status: "unhealthy",
          error: {
            category: "runtime_unavailable",
            code: "probe_threw",
            message: `Backend ${input.backend} probe failed`,
            retryable: true,
          },
          capabilities,
        };
      }
    },
    async open<Id extends BackendId<Specs>>(
      input: OpenSessionInput<Specs, Id>,
    ): Promise<OpenSessionResult<Specs, Id>> {
      const registration = registry.get(input.backend);
      const prepared = await host.prepareExecution({
        backend: input.backend,
        launchId: input.launch.launchId,
        workingDirectory: input.launch.workingDirectory,
      });
      if (!prepared.ok) return { ok: false, error: scrubDriverError(prepared.error) };
      const session = new LogicalAgentSession<Specs, Id>(
        input.backend,
        input.config,
        {
          workingDirectory: input.launch.workingDirectory,
          instructions: input.launch.instructions.content,
          resumeSessionId: input.launch.resumeSessionId,
          launchId: input.launch.launchId,
        },
        registration.createAdapter(),
        registration.capabilities,
        host,
        prepared.resource,
        hostReleaseTimeoutMs,
      );
      return { ok: true, session, capabilities: registration.capabilities };
    },
  };
}
