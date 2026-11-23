import { homedir } from "node:os";
import type { AdapterLaunchContext, BackendAdapter, RuntimeLaneOpenOptions, SpawnedProcess } from "../../internal/adapter.js";
import { prepareCliTransport } from "../../internal/cliTransport.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import { canLaunchMacosAgents } from "../../internal/macos-agent-launch.js";
import { nativeUsageHome } from "./usage.js";
import { AntigravityAcpLane } from "./acp-lane.js";
import { antigravitySpawnSpec, managedAntigravityExecutable, probeAntigravity } from "./probe.js";

export class AntigravityDriver implements BackendAdapter {
  readonly id = "antigravity";
  readonly modelCatalogOrigin = "native_report" as const;
  readonly instructionDelivery = { kind: "native" } as const;
  readonly execution = {
    lifetime: "session",
    transport: { kind: "stdio_rpc", protocol: "antigravity.acp.v1" },
    wakeStart: "immediate",
    terminalOwnership: "transport_request",
  } as const;

  probe(command?: string, includeModels = true) {
    return includeModels
      ? probeAntigravity(command)
      : probeAntigravity(command, { includeModels: false });
  }

  async openLane(ctx: AdapterLaunchContext, options?: RuntimeLaneOpenOptions) {
    return new AntigravityAcpLane(this, ctx, { onRawStdoutLine: options?.onRawStdoutLine });
  }

  async spawn(ctx: AdapterLaunchContext): Promise<SpawnedProcess & { usageHome: string }> {
    const { spawnEnv } = await prepareCliTransport(ctx);
    const command = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command;
    const spec = antigravitySpawnSpec(command);
    const managed = !command && canLaunchMacosAgents() ? managedAntigravityExecutable(spec.command, spawnEnv.HOME || homedir()) : undefined;
    return { usageHome: nativeUsageHome(spawnEnv, ctx.workingDirectory), process: spawnAgentProcess(managed ?? spec.command, spec.args, {
      cwd: ctx.workingDirectory,
      env: spawnEnv,
      shell: spec.shell,
      macosIdentity: true,
    }) };
  }
}
