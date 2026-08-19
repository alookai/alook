import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_BACKEND_IDS, type AgentSessionResult } from "@alook/agent-driver";
import { AgentProcessManager, type DaemonAgentSession } from "./managerRuntime.js";

function fakeSession(): DaemonAgentSession {
  return {
    backend: "codex",
    capabilities: {} as never,
    sessionInstanceId: "capability-test",
    events: {
      maxBufferedBytes: 4_194_304,
      async *[Symbol.asyncIterator]() { await new Promise(() => {}); },
    },
    closed: new Promise<AgentSessionResult>(() => {}),
    async start(message) {
      return { status: "accepted", delivery: "prompt", commandId: message.id, turnId: "capability-turn" };
    },
    async send(message) {
      return { status: "accepted", delivery: "steer", commandId: message.id, turnId: "capability-turn" };
    },
    async interrupt() { return { status: "not_running" }; },
    async stop() { return { status: "accepted", requestId: "capability-stop" }; },
    snapshot() {
      return { sessionInstanceId: "capability-test", state: "working", queuedCommands: [], lastEventSequence: 0 };
    },
    async invokeExtension() {
      return { ok: false, error: { category: "internal", code: "unsupported", message: "unsupported", retryable: false } };
    },
  };
}

describe("daemon/package capability boundary", () => {
  it("fails clearly when the daemon omits the required public session factory", () => {
    const manager = new AgentProcessManager({
      driverFor: () => ({ id: "pi", capabilities: {} as never, probe: async () => ({} as never) }),
      baseContextFor: (agentId) => ({ agentId, workingDirectory: "/tmp" }),
    });
    manager.register("agent");
    expect(() => manager.deliver("agent", { text: "hello" }))
      .toThrow("a public AgentSession factory is required");
  });

  it.each(BUILTIN_BACKEND_IDS)("%s registers and delivers without a lifecycle descriptor", (id) => {
    const manager = new AgentProcessManager({
      driverFor: () => ({
        id,
        capabilities: {} as never,
        probe: async () => ({ status: "unhealthy" as const, error: {} as never, capabilities: {} as never }),
      }),
      baseContextFor: (agentId) => ({ agentId, workingDirectory: "/tmp" }),
      sessionFactory: () => fakeSession(),
    });
    manager.register("agent");
    expect(manager.deliver("agent", { text: "hello" })).toBe(true);
  });

  it("manager and createDaemon contain no backend lifecycle or transport branch", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const managerSource = fs.readFileSync(path.join(here, "managerRuntime.ts"), "utf8");
    const daemonSource = fs.readFileSync(path.join(here, "..", "daemon", "createDaemon.ts"), "utf8");
    for (const source of [managerSource, daemonSource]) {
      expect(source).not.toMatch(/driver\.lifecycle|busyDeliveryMode|supportsStdinNotification|createSession\s*\(/);
    }
  });
});
