import { randomUUID } from "node:crypto";
import type { BuiltinBackendId, BuiltinBackendSpecs } from "../contract.js";
import type { AdapterLaunchContext, BackendAdapter, ProbeResult } from "./adapter.js";
import type { SdkWorkerFactory } from "./sdk-worker-api.js";
import { prepareCliTransport } from "./cliTransport.js";
import { resolveLaunchFieldsOrDefault } from "./config.js";
import { resolveOptionalPackage } from "./optional-package.js";
import { SdkWorkerLane } from "./sdk-worker-lane.js";

export class OptionalSdkDriver<Id extends BuiltinBackendId> implements BackendAdapter<Id, BuiltinBackendSpecs[Id]["config"]> {
  readonly modelCatalogOrigin = "native_report" as const;
  readonly execution;

  constructor(
    readonly id: Id,
    private readonly packageName: string,
    private readonly factory: SdkWorkerFactory,
    private readonly resolvePackage = resolveOptionalPackage,
    readonly instructionDelivery: BackendAdapter["instructionDelivery"] = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] },
  ) {
    this.execution = {
      lifetime: "session", transport: { kind: "stdio_rpc", protocol: `${id}.sdk-worker.v1` },
      wakeStart: "immediate", terminalOwnership: "prompt_invocation",
    } as const;
  }

  beginTurn(): string { return `${this.id}:${randomUUID()}`; }

  async probe(command?: string, includeModels = true): Promise<ProbeResult> {
    const installed = this.resolvePackage(this.packageName);
    if (!installed) return { status: "unhealthy", lastError: "sdk_not_installed" };
    const lane = new SdkWorkerLane(this.factory, {
      modulePath: installed.entry, cwd: process.cwd(), config: { command }, probe: { includeModels },
    }, { ...process.env, CI: "1" });
    try {
      const result = await lane.probe() as ProbeResult;
      if (result?.status !== "healthy" && result?.status !== "unhealthy") return { status: "unhealthy", lastError: "sdk_probe_invalid" };
      return { ...result, version: installed.version };
    } catch { return { status: "unhealthy", lastError: "sdk_probe_failed" }; }
    finally { await lane.stop({ reason: "probe_complete", forceAfterMs: 250 }); }
  }

  async openLane(ctx: AdapterLaunchContext<Id, BuiltinBackendSpecs[Id]["config"]>): Promise<SdkWorkerLane> {
    const installed = this.resolvePackage(this.packageName);
    if (!installed) throw new Error(`${this.packageName} is not installed`);
    const { spawnEnv } = await prepareCliTransport(ctx);
    const fields = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    const provider = ctx.config.runtimeConfig && "provider" in ctx.config.runtimeConfig ? ctx.config.runtimeConfig.provider : undefined;
    return new SdkWorkerLane(this.factory, {
      modulePath: installed.entry, cwd: ctx.workingDirectory, sessionId: ctx.config.sessionId, instructions: ctx.standingPrompt,
      config: { model: fields.model, command: fields.command, reasoningEffort: fields.reasoningEffort,
        ...(provider && "providerId" in provider ? { provider: { kind: provider.kind, providerId: provider.providerId, apiKey: provider.apiKey } } : {}),
      },
    }, spawnEnv);
  }
}
