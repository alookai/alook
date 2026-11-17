import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession, BuiltinBackendSpecs } from "@alook/agent-driver";
import { createAgentDriverSdkWithRegistry, createBuiltinAgentDriverRegistry } from "@alook/agent-driver/adapter-author";
import { createFakeAgentDriverHost } from "@alook/agent-driver/testing";
import type { AgentModelReport } from "@alook/shared";
import { AgentProcessManager } from "./managerRuntime.js";
import { ModelObservationReporter } from "../telemetry/modelObservations.js";

describe("native model observation through the logical driver and manager", () => {
  it.each(["pending", "failed"] as const)("finishes replies and cleanup while telemetry is %s, and flushes only the replacement epoch", async failure => {
    const directory = mkdtempSync(join(tmpdir(), "model-observation-chain-"));
    const command = join(directory, "native-fixture.cjs");
    writeFileSync(command, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const model = fs.readFileSync("model", "utf8");
const session = "native-" + process.pid;
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
fs.writeFileSync("pid", String(process.pid));
let input;
process.on("SIGUSR2", () => {
  emit({type:"assistant",session_id:session,message:{role:"assistant",id:"body",model,content:[{type:"text",text:"body-"+model}]}});
  emit({type:"result",subtype:"success",session_id:session,user_message_uuid:input.uuid,duration_ms:1});
});
emit({type:"system",subtype:"init",session_id:session});
readline.createInterface({input:process.stdin}).on("line", line => {
  input = JSON.parse(line);
  emit({...input,type:"user",isReplay:true,session_id:session});
  emit({type:"assistant",session_id:session,message:{role:"assistant",id:"metadata",model,content:[]}});
});
`);
    chmodSync(command, 0o755);
    const host = createFakeAgentDriverHost();
    const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry() });
    const sessions: AgentSession<BuiltinBackendSpecs, "claude">[] = [];
    const texts: string[] = [];
    const finals: string[] = [];
    const onError = vi.fn();
    const send = vi.fn((_report: AgentModelReport) => failure === "pending" ? new Promise<void>(() => {}) : Promise.reject(new Error("offline")));
    const runtimeConfig = { version: 1 as const, runtime: "claude", model: { kind: "default" as const }, mode: { kind: "default" as const } };
    const manager = new AgentProcessManager({
      driverFor: () => ({ id: "claude" }),
      baseContextFor: agentId => ({ agentId, workingDirectory: directory, standingPrompt: "", config: {} }),
      sessionFactory: async ({ ctx }) => {
        const opened = await sdk.open({ backend: "claude", launch: { workingDirectory: directory, launchId: ctx.launchId ?? "launch", instructions: { format: "markdown", content: "" } }, config: { model: { kind: "default" }, provider: { kind: "default" }, mode: "default", command } });
        if (!opened.ok) throw new Error(opened.error.message);
        sessions.push(opened.session);
        return opened.session;
      },
      onModelObserved: agentId => reporter.schedule(agentId),
      timeline: {
        barrierGeneration: () => 0,
        beginTurn: () => {},
        recordAssistantMessage: (_agentId, _owner, text) => { texts.push(text); },
        finalizeTurn: (_agentId, owner) => { finals.push(owner.rootTurnId); },
        fenceSession: () => {}, setSession: () => true, resumeSessionId: () => null, forgetSession: () => true,
      },
      tickIntervalMs: 60_000,
    });
    const reporter = new ModelObservationReporter(agentId => manager.modelReportFor(agentId), send, onError);
    try {
      writeFileSync(join(directory, "model"), "old");
      manager.register("bot", { runtimeConfig, launchId: "first" });
      manager.deliver("bot", { id: "first-input", text: "first" });
      await vi.waitFor(() => expect(manager.modelReportFor("bot")?.model).toBe("old"), { timeout: 4_000 });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { timeout: 7_000 });
      expect(texts).toEqual([]);
      process.kill(Number(readFileSync(join(directory, "pid"), "utf8")), "SIGUSR2");
      await vi.waitFor(() => expect(texts).toContain("body-old"));
      await vi.waitFor(() => expect(finals).toHaveLength(1));
      expect(sessions[0]!.snapshot().state).toBe("idle");
      reporter.schedule("bot");
      writeFileSync(join(directory, "model"), "new");
      await manager.resetSession("bot", { runtimeConfig, launchId: "replacement", rewakePrompt: "next" });
      await vi.waitFor(() => expect(manager.modelReportFor("bot")?.model).toBe("new"));
      expect((await sessions[0]!.closed).cleanup.status).toBe("released");
      expect(host.releases).toHaveLength(1);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 7_000 });
      expect(send.mock.calls.map(([report]) => report.model)).toEqual(["old", "new"]);
      expect(send.mock.calls[1]![0].sessionInstanceId).not.toBe(send.mock.calls[0]![0].sessionInstanceId);
      process.kill(Number(readFileSync(join(directory, "pid"), "utf8")), "SIGUSR2");
      await vi.waitFor(() => expect(texts).toContain("body-new"));
      await vi.waitFor(() => expect(finals).toHaveLength(2));
      await manager.stopAll();
      expect((await sessions[1]!.closed).cleanup.status).toBe("released");
      expect(host.releases).toHaveLength(2);
      if (failure === "failed") expect(onError).toHaveBeenCalledTimes(2);
      else expect(onError).not.toHaveBeenCalled();
    } finally {
      reporter.stop();
      await manager.stopAll();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
