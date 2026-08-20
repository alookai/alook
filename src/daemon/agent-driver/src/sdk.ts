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
import {
  assertAdapterCompatibility,
  createBuiltinAgentDriverRegistry,
  type AgentDriverRegistry,
} from "./registry.js";
import { LogicalAgentSession } from "./controller/logical-session.js";
import { scrubDriverError, stableErrorCode } from "./internal/errors.js";

export function createAgentDriverSdk(
  options: CreateAgentDriverSdkOptions = {},
): AgentDriverSdk<BuiltinBackendSpecs> {
  return createAgentDriverSdkWithRegistry({ ...options, registry: createBuiltinAgentDriverRegistry() });
}

export function createAgentDriverSdkWithRegistry<Specs>(
  options: CreateAgentDriverSdkOptions & { readonly registry: AgentDriverRegistry<Specs> },
): AgentDriverSdk<Specs> {
  const host = options.host ?? createDefaultAgentDriverHost();
  const hostReleaseTimeoutMs = options.hostReleaseTimeoutMs ?? 5_000;
  const registry = options.registry;
  return {
    backendIds: registry.backendIds,
    async probe<Id extends BackendId<Specs>>(
      input: ProbeInput<Specs, Id>,
    ): Promise<BackendProbe<CapabilitiesOf<Specs, Id>>> {
      const registration = registry.get(input.backend);
      const capabilities = registration.capabilities;
      try {
        const adapter = registration.createAdapter();
        assertAdapterCompatibility(String(registration.id), registration.capabilities, adapter);
        const command = (capabilities as { readonly commandOverride: boolean }).commandOverride
          ? input.command
          : undefined;
        const result = await adapter.probe(command);
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
      } catch (error) {
        const contractInvalid = error instanceof Error && error.message.startsWith("Adapter ");
        return {
          status: "unhealthy",
          error: {
            category: contractInvalid ? "internal" : "runtime_unavailable",
            code: contractInvalid ? "adapter_contract_invalid" : "probe_threw",
            message: contractInvalid
              ? `Backend ${input.backend} adapter contract is invalid`
              : `Backend ${input.backend} probe failed`,
            retryable: !contractInvalid,
          },
          capabilities,
        };
      }
    },
    async open<Id extends BackendId<Specs>>(
      input: OpenSessionInput<Specs, Id>,
    ): Promise<OpenSessionResult<Specs, Id>> {
      const registration = registry.get(input.backend);
      let adapter;
      try {
        adapter = registration.createAdapter();
        assertAdapterCompatibility(String(registration.id), registration.capabilities, adapter);
      } catch {
        return {
          ok: false,
          error: {
            category: "internal",
            code: "adapter_contract_invalid",
            message: `Backend ${input.backend} adapter contract is invalid`,
            retryable: false,
          },
        };
      }
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
        adapter,
        registration.capabilities,
        host,
        prepared.resource,
        hostReleaseTimeoutMs,
      );
      return { ok: true, session, capabilities: registration.capabilities };
    },
  };
}
