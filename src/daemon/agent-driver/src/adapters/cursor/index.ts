/**
 * Cursor driver — persistent Agent Client Protocol (ACP) over stdio.
 *
 * One `cursor-agent acp` process owns one physical Cursor session. A root
 * prompt establishes the stable terminal owner; busy input steers through a
 * concurrent `session/prompt` with its own JSON-RPC request id. Superseded
 * responses settle only their own request, and only the current prompt can
 * emit the root terminal.
 */
import type {
  AdapterLaunchContext,
  BackendAdapter,
  RuntimeLane,
  RuntimeLaneOpenOptions,
  SpawnedProcess,
} from "../../internal/adapter.js";
import { prepareCliTransport } from "../../internal/cliTransport.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import {
  probeCliRuntime,
  resolveSpawnSpec,
} from "../../internal/probe.js";
import { CursorAcpLane, type CursorAcpProcessFactory } from "./acp-lane.js";
import { probeCursorAcpCatalog } from "./catalog-probe.js";
import type { RuntimeReasoningCatalog } from "../../contract.js";

export class CursorDriver implements BackendAdapter, CursorAcpProcessFactory {
  readonly id = "cursor";
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly execution = {
    lifetime: "session",
    transport: { kind: "stdio_rpc", protocol: "cursor.acp.v1" },
    wakeStart: "immediate",
    terminalOwnership: "transport_request",
  } as const;

  constructor(
    private readonly catalogProbe: (command?: string) => Promise<RuntimeReasoningCatalog | undefined> = probeCursorAcpCatalog,
  ) {}

  async probe(command?: string) {
    const result = probeCliRuntime("cursor-agent", {}, command);
    if (result.status !== "healthy") return result;
    let reasoning: RuntimeReasoningCatalog | undefined;
    try {
      reasoning = await this.catalogProbe(command);
    } catch {
      reasoning = undefined;
    }
    return {
      ...result,
      reasoning,
    };
  }

  async openLane(ctx: AdapterLaunchContext, options?: RuntimeLaneOpenOptions): Promise<RuntimeLane> {
    return new CursorAcpLane(this, ctx, { onRawStdoutLine: options?.onRawStdoutLine });
  }

  async spawn(ctx: AdapterLaunchContext): Promise<SpawnedProcess> {
    const { spawnEnv } = await prepareCliTransport(ctx);
    const override = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command;
    const spec = resolveSpawnSpec("cursor-agent", ["acp"], override);
    return {
      process: spawnAgentProcess(spec.command, spec.args, {
        cwd: ctx.workingDirectory,
        env: spawnEnv,
        shell: spec.shell,
      }),
    };
  }
}
