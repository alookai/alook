import { describe, it, expect } from "vitest";
import { AgentProcessManager, type TimelineRecorder } from "./managerRuntime";
import type { LaunchContext } from "../types";

/** A recorder that records calls + can supply a resume session id. */
function fakeRecorder(resume: Record<string, string> = {}) {
  const calls: string[] = [];
  const rec: TimelineRecorder = {
    setSession: (agentId, sessionId) => calls.push(`session:${agentId}:${sessionId}`),
    appendResponseToLatest: (agentId, text) => calls.push(`resp:${agentId}:${text}`),
    resumeSessionId: (agentId) => resume[agentId] ?? null,
  };
  return { rec, calls };
}

function manager(rec: TimelineRecorder, capture: { ctx?: LaunchContext }) {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const mgr = new AgentProcessManager({
    driverFor: () =>
      ({ lifecycle: { kind: "persistent" }, supportsStdinNotification: true, busyDeliveryMode: "gated" }) as never,
    baseContextFor: (agentId) => ({ agentId, workingDirectory: "/tmp/x", standingPrompt: "", config: {} }),
    sessionFactory: ({ ctx }) => {
      capture.ctx = ctx;
      return {
        on: (ev: string, cb: (arg?: unknown) => void) => ((handlers[ev] ??= []).push(cb)),
        get currentSessionId() {
          return null;
        },
        async start() {},
        send() {
          return { ok: true };
        },
        async stop() {},
      };
    },
    timeline: rec,
    tickIntervalMs: 10_000,
  });
  const emit = (ev: string, arg?: unknown) => (handlers[ev] ?? []).forEach((h) => h(arg));
  return { mgr, emit };
}

describe("manager ↔ timeline (daily log + resume)", () => {
  it("annotates the latest entry on session_init / text / exit (by agent, not task id)", () => {
    const { rec, calls } = fakeRecorder();
    const cap: { ctx?: LaunchContext } = {};
    const { mgr, emit } = manager(rec, cap);
    mgr.register("agent_1");
    mgr.deliver("agent_1", { seq: 1, text: "hi" });

    emit("runtime_event", { kind: "session_init", sessionId: "sess-7" });
    emit("runtime_event", { kind: "text", text: "part 1" });
    emit("runtime_event", { kind: "text", text: "part 2" });
    emit("runtime_event", { kind: "text", text: "" }); // empty text ignored
    emit("exit");

    // The manager does NOT open the entry (that's the data plane / inbox pull)
    // and there's no status close — it records the session id and accumulates the
    // agent's text onto the latest row.
    expect(calls).toEqual([
      "session:agent_1:sess-7",
      "resp:agent_1:part 1",
      "resp:agent_1:part 2",
    ]);
  });

  it("uses the timeline's resume session id when spawning", () => {
    const { rec } = fakeRecorder({ agent_2: "sess-prev" });
    const cap: { ctx?: LaunchContext } = {};
    const { mgr } = manager(rec, cap);
    mgr.register("agent_2");
    mgr.deliver("agent_2", { seq: 1, text: "hi" });
    expect(cap.ctx?.config.sessionId).toBe("sess-prev");
  });
});
