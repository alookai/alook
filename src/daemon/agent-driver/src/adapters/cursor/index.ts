/**
 * Cursor driver — persistent Agent Client Protocol (ACP) over stdio.
 *
 * One `cursor-agent acp` process owns one physical Cursor session. Root
 * prompts are correlated by their JSON-RPC request ids; the matching
 * `session/prompt` response is the only authoritative terminal for that turn.
 * Cursor does not accept mid-turn steering here, so LogicalAgentSession keeps
 * busy input in its next-turn FIFO until the active prompt settles.
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
import { probeCliRuntime, resolveSpawnSpec } from "../../internal/probe.js";
import { CursorAcpLane, type CursorAcpProcessFactory } from "./acp-lane.js";

export class CursorDriver implements BackendAdapter, CursorAcpProcessFactory {
  readonly id = "cursor";
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly execution = {
    lifetime: "session",
    transport: { kind: "stdio_rpc", protocol: "cursor.acp.v1" },
    wakeStart: "immediate",
    terminalOwnership: "transport_request",
  } as const;

  probe(command?: string) {
    return probeCliRuntime("cursor-agent", {}, command);
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
