import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession, BuiltinBackendSpecs } from "@alook/agent-driver";
import { createAgentDriverSdkWithRegistry, createBuiltinAgentDriverRegistry } from "@alook/agent-driver/adapter-author";
import { createFakeAgentDriverHost } from "@alook/agent-driver/testing";
import type { HostAgentActivity } from "@alook/shared";
import { AgentProcessManager } from "./managerRuntime.js";

describe("native model observation through the logical driver and manager", () => {
  it.each(["pending", "failed"] as const)("finishes replies and cleanup while telemetry is %s, and samples only the current epoch on existing activity reports", async failure => {
    const directory = mkdtempSync(join(tmpdir(), "model-observation-chain-"));
    const script = join(directory, "native-fixture.cjs");
    const command = process.platform === "win32" ? join(directory, "native-fixture.cmd") : script;
    writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const model = fs.readFileSync("model", "utf8");
const session = "native-" + process.pid;
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
let input;
const gate = setInterval(() => {
  if (!input || !fs.existsSync("release-" + model)) return;
  clearInterval(gate);
  emit({type:"assistant",session_id:session,message:{role:"assistant",id:"body",model,content:[{type:"text",text:"body-"+model}]}});
  emit({type:"result",subtype:"success",session_id:session,user_message_uuid:input.uuid,duration_ms:1});
}, 10);
emit({type:"system",subtype:"init",session_id:session});
readline.createInterface({input:process.stdin}).on("line", line => {
  input = JSON.parse(line);
  emit({...input,type:"user",isReplay:true,session_id:session});
  emit({type:"assistant",session_id:session,message:{role:"assistant",id:"metadata",model,content:[]}});
});
`);
    if (process.platform === "win32") writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    else chmodSync(script, 0o755);
    const host = createFakeAgentDriverHost();
    const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry() });
    const sessions: AgentSession<BuiltinBackendSpecs, "claude">[] = [];
    const texts: string[] = [];
    const finals: string[] = [];
    const onError = vi.fn();
    const send = vi.fn((_report: HostAgentActivity) => failure === "pending" ? new Promise<void>(() => {}) : Promise.reject(new Error("offline")));
    const runtimeConfig = { version: 1 as const, runtimeConfigRevision: 3, runtime: "claude", model: { kind: "default" as const }, mode: { kind: "default" as const } };
    const reportActivity = (info: { agentId: string; state: HostAgentActivity["state"] }): void => {
      void Promise.resolve().then(() => {
        const modelObservation = manager.modelReportFor(info.agentId);
        return send({ ...info, ...(modelObservation ? { modelObservation } : {}) });
      }).catch(onError);
    };
    const manager = new AgentProcessManager({
      driverFor: () => ({ id: "claude" }),
      baseContextFor: agentId => ({ agentId, workingDirectory: directory, standingPrompt: "", config: {} }),
      sessionFactory: async ({ ctx }) => {
        const opened = await sdk.open({ backend: "claude", launch: { workingDirectory: directory, launchId: ctx.launchId ?? "launch", instructions: { format: "markdown", content: "" } }, config: { model: { kind: "default" }, provider: { kind: "default" }, mode: "default", command } });
        if (!opened.ok) throw new Error(opened.error.message);
        sessions.push(opened.session);
        return opened.session;
      },
      onAgentActivity: reportActivity,
      timeline: {
        barrierGeneration: () => 0,
        beginTurn: () => {},
        recordAssistantMessage: (_agentId, _owner, text) => { texts.push(text); },
        finalizeTurn: (_agentId, owner) => { finals.push(owner.rootTurnId); },
        fenceSession: () => {}, setSession: () => true, resumeSessionId: () => null, forgetSession: () => true,
      },
      tickIntervalMs: 60_000,
    });
    try {
      writeFileSync(join(directory, "model"), "old");
      manager.register("bot", { runtimeConfig, launchId: "first" });
      manager.deliver("bot", { id: "first-input", text: "first" });
      await vi.waitFor(() => expect(manager.modelReportFor("bot")?.model).toBe("old"), { timeout: 4_000 });
      expect(manager.modelReportFor("bot")?.runtimeConfigRevision).toBe(3);
      const before = send.mock.calls.length;
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(send).toHaveBeenCalledTimes(before);
      reportActivity({ agentId: "bot", state: "running" });
      await vi.waitFor(() => expect(send.mock.calls.some(([activity]) => activity.modelObservation?.model === "old")).toBe(true));
      expect(texts).toEqual([]);
      writeFileSync(join(directory, "release-old"), "go");
      await vi.waitFor(() => expect(texts).toContain("body-old"));
      await vi.waitFor(() => expect(finals).toHaveLength(1));
      expect(sessions[0]!.snapshot().state).toBe("idle");
      writeFileSync(join(directory, "model"), "new");
      await manager.resetSession("bot", { runtimeConfig: { ...runtimeConfig, runtimeConfigRevision: 4 }, launchId: "replacement", rewakePrompt: "next" });
      await vi.waitFor(() => expect(manager.modelReportFor("bot")?.model).toBe("new"), { timeout: 4_000 });
      expect(manager.modelReportFor("bot")?.runtimeConfigRevision).toBe(4);
      expect((await sessions[0]!.closed).cleanup.status).toBe("released");
      expect(host.releases).toHaveLength(1);
      const priorReports = send.mock.calls.length;
      reportActivity({ agentId: "bot", state: "running" });
      await vi.waitFor(() => expect(send.mock.calls.at(-1)?.[0].modelObservation?.model).toBe("new"));
      expect(send.mock.calls.slice(priorReports).every(([activity]) => activity.modelObservation?.model !== "old")).toBe(true);
      writeFileSync(join(directory, "release-new"), "go");
      await vi.waitFor(() => expect(texts).toContain("body-new"));
      await vi.waitFor(() => expect(finals).toHaveLength(2));
      await manager.stopAll();
      expect((await sessions[1]!.closed).cleanup.status).toBe("released");
      expect(host.releases).toHaveLength(2);
      if (failure === "failed") expect(onError).toHaveBeenCalled();
      else expect(onError).not.toHaveBeenCalled();
    } finally {
      await manager.stopAll();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
