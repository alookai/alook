/**
 * OpenCode driver — CLI-major lanes over authenticated loopback HTTP/SSE.
 *
 * One `opencode serve` process owns one logical Alook session. CLI v1 retains
 * its durable event admission frontier. CLI v2 recovers persisted inputs and
 * messages and requires a new native idle record after every accepted input.
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
import {
  probeCliRuntime,
  probeCommandOutput,
  resolveSpawnSpec,
  type CommandOutputProbeResult,
} from "../../internal/probe.js";
import { parseOpenCodeModelCatalog } from "../../internal/modelCatalog.js";
import {
  OpenCodeServiceLane,
  type OpenCodeServiceProcessFactory,
} from "./service-lane.js";
import { legacyOpenCodeApiEnvironment } from "./legacy-auth.js";
import { discoverOpenCodeRecentContext } from "./recent-context.js";
import { OPEN_CODE_V1, resolveOpenCodeCompatibility, type OpenCodeCompatibility } from "./compatibility.js";
import { OpenCodeV2ServiceLane } from "./v2-service-lane.js";

function createOpenCodeMessageId(): string {
  return `msg_${randomBytes(16).toString("hex")}`;
}

export class OpenCodeDriver implements BackendAdapter, OpenCodeServiceProcessFactory {
  readonly id = "opencode";
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly execution = {
    lifetime: "session",
    transport: { kind: "http_sse", protocol: "opencode.v2.service" },
    wakeStart: "immediate",
    terminalOwnership: "transport_request",
  } as const;

  constructor(
    private readonly outputProbe: (command: string, args: string[]) => CommandOutputProbeResult = probeCommandOutput,
    private readonly versionProbe: typeof probeCliRuntime = probeCliRuntime,
  ) {}

  discoverRecentContext(request: Parameters<typeof discoverOpenCodeRecentContext>[0]) {
    if (request.recentProjectsTopK === 0) return discoverOpenCodeRecentContext(request);
    const result = this.versionProbe("opencode", {}, request.command);
    if (result.status !== "healthy") throw new Error("Installed OpenCode CLI could not report its version");
    return discoverOpenCodeRecentContext(request, { compatibility: resolveOpenCodeCompatibility(result.version) });
  }

  probe(command?: string) {
    const result = this.versionProbe("opencode", {}, command);
    if (result.status !== "healthy") return result;
    let compatibility: OpenCodeCompatibility;
    try {
      compatibility = resolveOpenCodeCompatibility(result.version);
    } catch {
      return { ...result, status: "unhealthy" as const, lastError: "unsupported_opencode_cli_version" };
    }
    const spec = resolveSpawnSpec("opencode", [...compatibility.modelArgs], command);
    const output = this.outputProbe(spec.command, spec.args);
    return {
      ...result,
      reasoning: output.ok ? parseOpenCodeModelCatalog(output.output) : undefined,
    };
  }

  beginTurn(): string {
    return createOpenCodeMessageId();
  }

  async openLane(ctx: AdapterLaunchContext, options?: RuntimeLaneOpenOptions): Promise<RuntimeLane> {
    const command = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command;
    const result = this.versionProbe("opencode", {}, command);
    if (result.status !== "healthy") throw new Error("Installed OpenCode CLI could not report its version");
    const compatibility = resolveOpenCodeCompatibility(result.version);
    const factory: OpenCodeServiceProcessFactory = {
      spawnService: (launch, port, password) => this.spawnService(launch, port, password, compatibility),
    };
    const Lane = compatibility.major === 1 ? OpenCodeServiceLane : OpenCodeV2ServiceLane;
    return new Lane(factory, ctx, {
      onRawStdoutLine: options?.onRawStdoutLine,
    });
  }

  async spawnService(
    ctx: AdapterLaunchContext,
    port: number,
    password: string,
    compatibility: OpenCodeCompatibility = OPEN_CODE_V1,
  ): Promise<SpawnedProcess> {
    const { spawnEnv } = await prepareCliTransport(ctx, {
      OPENCODE_SERVER_PASSWORD: password,
      ...(compatibility.major === 2 ? { OPENCODE_PASSWORD: password } : {}),
    });
    const fields = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    Object.assign(spawnEnv, await legacyOpenCodeApiEnvironment(spawnEnv, fields.model));
    const override = fields.command;
    const args = [
      ...compatibility.serviceArgs,
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
