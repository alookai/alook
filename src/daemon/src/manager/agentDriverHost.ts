import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDriverHost, PreparedExecutionResource } from "@alook/agent-driver";
import type { HostLaunchContext } from "./hostContext.js";
import { buildGitIdentityEnv, readHostGitIdentity } from "../drivers/gitIdentityEnv.js";

function runtimeEnvironment(ctx: HostLaunchContext): Record<string, string | undefined> {
  const runtime = ctx.config.runtimeContext;
  if (!runtime) return {};
  return {
    ALOOK_AGENT_ID: runtime.agentId,
    ALOOK_SERVER_ID: runtime.serverId,
    ALOOK_COMPUTER_ID: runtime.computerId,
    ALOOK_COMPUTER_NAME: runtime.computerName,
    ALOOK_HOSTNAME: runtime.hostname,
    ALOOK_OS: runtime.os,
    ALOOK_DAEMON_VERSION: runtime.daemonVersion,
    ALOOK_WORKSPACE_PATH: runtime.workspacePath,
  };
}

export function createDaemonAgentDriverHost(
  ctx: HostLaunchContext,
  onRawLine?: (line: string) => void,
): AgentDriverHost {
  return {
    async prepareExecution() {
      const handoff = ctx.credentialProxy;
      if (!handoff) {
        return {
          ok: false,
          error: {
            category: "configuration" as const,
            code: "credential_proxy_required",
            message: "Daemon launches require a credential proxy handoff",
            retryable: false,
          },
        };
      }
      if (!Array.isArray(handoff.capabilities) || handoff.capabilities.some((item) => item.includes(","))) {
        return {
          ok: false,
          error: {
            category: "configuration" as const,
            code: "invalid_capabilities",
            message: "Credential capabilities must be comma-free string tokens",
            retryable: false,
          },
        };
      }
      if (!ctx.agentCliPath) {
        return {
          ok: false,
          error: {
            category: "configuration" as const,
            code: "agent_cli_required",
            message: "Daemon launches require a resolvable agent CLI path",
            retryable: false,
          },
        };
      }
      handoff.broker.revokeAgent(ctx.agentId);
      const registration = handoff.broker.mint(
        ctx.agentId,
        ctx.launchId ?? "default",
        handoff.capabilities,
        handoff.runnerKey,
      );
      const resource: PreparedExecutionResource = {
        executablePath: ctx.agentCliPath,
        environmentLayers: {
          base: { ...process.env },
          hostStatic: {},
          identityProtected: buildGitIdentityEnv({
            agentName: ctx.config.agentName,
            discriminator: ctx.config.agentDiscriminator,
            hostUser: readHostGitIdentity() ?? undefined,
          }),
          platformProtected: {
            ALOOK_HOME: process.env.ALOOK_HOME ?? join(homedir(), ".alook"),
            ALOOK_ID: ctx.agentId,
            ALOOK_CLI: ctx.agentCliPath,
            ALOOK_SERVER_URL: ctx.config.serverUrl,
            ALOOK_ACTIVE_CAPABILITIES: handoff.capabilities.join(","),
            ALOOK_LAUNCH_ID: ctx.launchId,
            ALOOK_TRACE_DIR: ctx.cliTransportTraceDir,
          },
          runtimeProtected: runtimeEnvironment(ctx),
          networkProtected: {
            NO_PROXY: ["127.0.0.1", "localhost", process.env.NO_PROXY].filter(Boolean).join(","),
            PATH: process.env.PATH,
          },
          credentialSensitive: {
            ALOOK_PROXY_URL: handoff.proxyUrl,
            ALOOK_PROXY_TOKEN_FILE: registration.voucherFile,
          },
        },
        async release() {
          handoff.broker.revoke(registration.voucher);
        },
      };
      return { ok: true, resource };
    },
    onRawOutput(event) {
      if (event.stream === "stdout") onRawLine?.(event.text);
    },
    now: () => Date.now(),
    createId: () => randomUUID(),
  };
}
