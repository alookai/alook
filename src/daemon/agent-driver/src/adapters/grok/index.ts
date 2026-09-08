import type {
  AdapterLaunchContext,
  BackendAdapter,
  RuntimeLane,
  RuntimeLaneOpenOptions,
  SpawnedProcess,
  SpawnedProcessHandle,
} from "../../internal/adapter.js";
import { prepareCliTransport } from "../../internal/cliTransport.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import { probeCliRuntime, resolveSpawnSpec } from "../../internal/probe.js";
import { GrokAcpLane, type GrokAcpProcessFactory } from "./acp-lane.js";
import { probeGrokAcpCatalog, type GrokAcpProbeResult } from "./catalog-probe.js";
import { discoverGrokRecentContext } from "./recent-context.js";

type GrokSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: boolean },
) => SpawnedProcessHandle;

export class GrokDriver implements BackendAdapter, GrokAcpProcessFactory {
  readonly id = "grok";
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly execution = {
    lifetime: "session",
    transport: { kind: "stdio_rpc", protocol: "grok.acp.v1" },
    wakeStart: "immediate",
    terminalOwnership: "transport_request",
  } as const;

  discoverRecentContext(request: Parameters<typeof discoverGrokRecentContext>[0]) {
    return discoverGrokRecentContext(request);
  }

  constructor(
    private readonly catalogProbe: (command?: string) => Promise<GrokAcpProbeResult> = probeGrokAcpCatalog,
    private readonly spawnProcess: GrokSpawn = spawnAgentProcess,
  ) {}

  async probe(command?: string) {
    const result = probeCliRuntime("grok", {}, command);
    if (result.status !== "healthy") return result;
    let acpProbe: GrokAcpProbeResult;
    try {
      acpProbe = await this.catalogProbe(command);
    } catch {
      acpProbe = { status: "unhealthy", lastError: "grok_acp_probe_failed" };
    }
    if (acpProbe.status === "unhealthy") {
      return { ...result, status: "unhealthy" as const, lastError: acpProbe.lastError };
    }
    return { ...result, reasoning: acpProbe.reasoning };
  }

  async openLane(ctx: AdapterLaunchContext, options?: RuntimeLaneOpenOptions): Promise<RuntimeLane> {
    return new GrokAcpLane(this, ctx, { onRawStdoutLine: options?.onRawStdoutLine });
  }

  async spawn(ctx: AdapterLaunchContext): Promise<SpawnedProcess> {
    const { spawnEnv } = await prepareCliTransport(ctx, { GROK_DISABLE_AUTOUPDATER: "1" });
    const override = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command;
    const spec = resolveSpawnSpec("grok", ["agent", "--no-leader", "stdio"], override);
    return {
      process: this.spawnProcess(spec.command, spec.args, {
        cwd: ctx.workingDirectory,
        env: { ...spawnEnv, GROK_DISABLE_AUTOUPDATER: "1" },
        shell: spec.shell,
      }),
    };
  }
}
