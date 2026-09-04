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
  RecentContextDiscoveryInput,
  RecentContextDiscoveryResult,
} from "./contract.js";
import { createDefaultAgentDriverHost } from "./host/default-host.js";
import {
  assertAdapterCompatibility,
  assertRegistrationShape,
  createBuiltinAgentDriverRegistry,
  type AgentDriverRegistry,
} from "./registry.js";
import { LogicalAgentSession } from "./controller/logical-session.js";
import { scrubDriverError, stableErrorCode } from "./internal/errors.js";
import { isValidRecentContextTopK, sanitizeRecentContextData } from "./internal/recent-context.js";

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
    async discoverRecentContext<Id extends BackendId<Specs>>(
      input: RecentContextDiscoveryInput<Specs, Id>,
    ): Promise<RecentContextDiscoveryResult> {
      if (
        !isValidRecentContextTopK(input.recentSessionFilesTopK)
        || !isValidRecentContextTopK(input.recentProjectsTopK)
      ) {
        return {
          ok: false,
          error: {
            category: "configuration",
            code: "invalid_recent_context_top_k",
            message: "Recent-context Top-K values must be non-negative safe integers",
            retryable: false,
          },
        };
      }
      const registration = registry.get(input.backend);
      try {
        assertRegistrationShape(registration);
        const adapter = registration.createAdapter();
        assertAdapterCompatibility(String(registration.id), registration.capabilities, adapter);
        if (!adapter.discoverRecentContext) {
          return {
            ok: false,
            error: {
              category: "configuration",
              code: "recent_context_discovery_unsupported",
              message: `Backend ${input.backend} does not support recent-context discovery`,
              retryable: false,
            },
          };
        }
        const command = (registration.capabilities as { readonly commandOverride: boolean }).commandOverride
          ? input.command
          : undefined;
        const discovered = await adapter.discoverRecentContext({
          recentSessionFilesTopK: input.recentSessionFilesTopK,
          recentProjectsTopK: input.recentProjectsTopK,
          ...(command ? { command } : {}),
        });
        const sanitized = sanitizeRecentContextData(discovered, input);
        if (!sanitized) throw new Error(`Adapter ${input.backend} returned invalid recent-context data`);
        return { ok: true, ...sanitized };
      } catch (error) {
        const contractInvalid = error instanceof Error && (
          error.message.startsWith("Adapter ")
          || error.message.startsWith("Agent backend registration ")
        );
        return {
          ok: false,
          error: {
            category: contractInvalid ? "internal" : "runtime_unavailable",
            code: contractInvalid ? "adapter_contract_invalid" : "recent_context_discovery_failed",
            message: contractInvalid
              ? `Backend ${input.backend} adapter contract is invalid`
              : `Backend ${input.backend} recent-context discovery failed`,
            retryable: !contractInvalid,
          },
        };
      }
    },
    async probe<Id extends BackendId<Specs>>(
      input: ProbeInput<Specs, Id>,
    ): Promise<BackendProbe<CapabilitiesOf<Specs, Id>>> {
      const registration = registry.get(input.backend);
      const capabilities = registration.capabilities;
      try {
        assertRegistrationShape(registration);
        const adapter = registration.createAdapter();
        assertAdapterCompatibility(String(registration.id), registration.capabilities, adapter);
        const command = (capabilities as { readonly commandOverride: boolean }).commandOverride
          ? input.command
          : undefined;
        const result = await adapter.probe(command);
        if (result.status === "healthy") {
          return {
            status: "healthy",
            version: result.version,
            capabilities,
            reasoning: result.reasoning,
          };
        }
        return {
          status: "unhealthy",
          error: {
            category: "runtime_unavailable",
            code: stableErrorCode(result.lastError, "probe_failed"),
            message: `Backend ${input.backend} is unavailable`,
            retryable: true,
          },
          capabilities,
          reasoning: result.reasoning,
        };
      } catch (error) {
        const contractInvalid = error instanceof Error && (
          error.message.startsWith("Adapter ")
          || error.message.startsWith("Agent backend registration ")
        );
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
        assertRegistrationShape(registration);
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
