/**
 * OpenCode driver — persistent v2 service over authenticated loopback HTTP/SSE.
 *
 * One `opencode serve` process owns one logical Alook session. The lane uses
 * caller-generated message ids for durable prompt admission and an
 * admission-frontier-bound `/api/session/active` query as the terminal owner.
 */
import { randomBytes } from "node:crypto";
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
import {
  OpenCodeServiceLane,
  type OpenCodeServiceProcessFactory,
} from "./service-lane.js";

function createOpenCodeMessageId(): string {
  return `msg_${randomBytes(16).toString("hex")}`;
}

export class OpenCodeDriver implements BackendAdapter, OpenCodeServiceProcessFactory {
  readonly id = "opencode";
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly execution = {
    lifetime: "session",
    transport: { kind: "http_sse", protocol: "opencode.v2.service.1.17.20" },
    wakeStart: "immediate",
    terminalOwnership: "transport_request",
  } as const;

  probe(command?: string) {
    return probeCliRuntime("opencode", {}, command);
  }

  beginTurn(): string {
    return createOpenCodeMessageId();
  }

  async openLane(ctx: AdapterLaunchContext, options?: RuntimeLaneOpenOptions): Promise<RuntimeLane> {
    return new OpenCodeServiceLane(this, ctx, {
      onRawStdoutLine: options?.onRawStdoutLine,
    });
  }

  async spawnService(ctx: AdapterLaunchContext, port: number, password: string): Promise<SpawnedProcess> {
    const { spawnEnv } = await prepareCliTransport(ctx, {
      OPENCODE_SERVER_PASSWORD: password,
    });
    const override = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command;
    const args = [
      "serve",
      "--pure",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ];
    const spec = resolveSpawnSpec("opencode", args, override);
    return {
      process: spawnAgentProcess(spec.command, spec.args, {
        cwd: ctx.workingDirectory,
        env: spawnEnv,
        shell: spec.shell,
      }),
    };
  }
}
