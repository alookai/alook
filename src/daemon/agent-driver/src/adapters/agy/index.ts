import type { AdapterLaunchContext, BackendAdapter, RuntimeLaneOpenOptions, SpawnedProcess } from "../../internal/adapter.js";
import { prepareCliTransport } from "../../internal/cliTransport.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import { agyStateHome } from "./execution.js";
import { AgyAcpLane } from "./acp-lane.js";
import { agySpawnSpec, probeAgy } from "./probe.js";

export class AgyDriver implements BackendAdapter<"agy"> {
  readonly id = "agy";
  readonly modelCatalogOrigin = "native_report" as const;
  readonly instructionDelivery = { kind: "native" } as const;
  readonly execution = {
    lifetime: "session", transport: { kind: "stdio_rpc", protocol: "agy.acp.v1" },
    wakeStart: "immediate", terminalOwnership: "transport_request",
  } as const;

  probe(command?: string, includeModels = true) { return probeAgy(command, includeModels); }

  async openLane(ctx: AdapterLaunchContext<"agy">, options?: RuntimeLaneOpenOptions) {
    return new AgyAcpLane(this, ctx, { onRawStdoutLine: options?.onRawStdoutLine });
  }

  async spawn(ctx: AdapterLaunchContext): Promise<SpawnedProcess & { stateHome: string }> {
    const { spawnEnv } = await prepareCliTransport(ctx);
    const spec = agySpawnSpec(resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command);
    const stateHome = agyStateHome(spawnEnv, ctx.workingDirectory);
    const args = ["acp", "--dangerously-skip-permissions", "--process-per-session",
      "--gemini-dir", stateHome,
    ];
    return { stateHome, process: spawnAgentProcess(spec.command, args, { cwd: ctx.workingDirectory, env: spawnEnv, shell: spec.shell }) };
  }
}
