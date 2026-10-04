import type { AdapterLaunchContext, BackendAdapter, RuntimeLaneOpenOptions, SpawnedProcess } from "../../internal/adapter.js";
import { prepareCliTransport } from "../../internal/cliTransport.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import { nativeUsageHome } from "./usage.js";
import { AntigravityAcpLane } from "./acp-lane.js";
import { antigravitySpawnSpec, probeAntigravity } from "./probe.js";

export class AntigravityDriver implements BackendAdapter {
  readonly id = "antigravity";
  readonly instructionDelivery = { kind: "native" } as const;
  readonly execution = {
    lifetime: "session",
    transport: { kind: "stdio_rpc", protocol: "antigravity.acp.v1" },
    wakeStart: "immediate",
    terminalOwnership: "transport_request",
  } as const;

  probe(command?: string) {
    return probeAntigravity(command);
  }

  async openLane(ctx: AdapterLaunchContext, options?: RuntimeLaneOpenOptions) {
    return new AntigravityAcpLane(this, ctx, { onRawStdoutLine: options?.onRawStdoutLine });
  }

  async spawn(ctx: AdapterLaunchContext): Promise<SpawnedProcess & { usageHome: string }> {
    const { spawnEnv } = await prepareCliTransport(ctx);
    const spec = antigravitySpawnSpec(resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command);
    return { usageHome: nativeUsageHome(spawnEnv, ctx.workingDirectory), process: spawnAgentProcess(spec.command, spec.args, {
      cwd: ctx.workingDirectory, env: spawnEnv, shell: spec.shell,
    }) };
  }
}
