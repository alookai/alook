import { describe, expect, it, vi } from "vitest";
import type { HostCommand } from "@alook/shared";
import { WakeCoordinator } from "./wakeCoordinator.js";

type Wake = Extract<HostCommand, { type: "agent:wake" }>;

function wake(agentId: string, channel: string, seq: number, launchId = `${agentId}-${channel}-${seq}`): Wake {
  return {
    type: "agent:wake",
    agentId,
    launchId,
    config: {} as Wake["config"],
    unreadNotice: { kind: "unread_notice", channel, latestSeq: seq },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("WakeCoordinator", () => {
  it("admits only one active turn per agent across channels", async () => {
    const coordinator = new WakeCoordinator();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = vi.fn(async () => blocked);

    const first = coordinator.run(wake("a1", "/s/c1", 1), dispatch);
    await tick();
    await expect(coordinator.run(wake("a1", "/s/c2", 1), dispatch)).resolves.toMatchObject({ state: "suppressed" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toEqual({ state: "accepted" });
  });

  it("delivers the first higher watermark into an active agent after the prior wake was seen", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async (command: Wake) => {
      coordinator.recordDeliveryAck(command.agentId, command.launchId, "ok");
    });

    await coordinator.run(wake("a1", "/s/c", 1), dispatch);
    coordinator.recordAgentActivity("a1", "running");
    coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#1" }], 0);

    await expect(coordinator.run(wake("a1", "/s/c", 2), dispatch)).resolves.toEqual({ state: "accepted" });
    expect(dispatch.mock.calls.map(([command]) => command.unreadNotice.latestSeq)).toEqual([1, 2]);
  });

  it("coalesces a five-message busy burst into one active-agent delivery until the pull covers it", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async (command: Wake) => {
      coordinator.recordDeliveryAck(command.agentId, command.launchId, "ok");
    });

    await coordinator.run(wake("a1", "/s/c", 1), dispatch);
    coordinator.recordAgentActivity("a1", "running");
    coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#1" }], 0);

    await expect(coordinator.run(wake("a1", "/s/c", 2), dispatch)).resolves.toEqual({ state: "accepted" });
    for (let seq = 3; seq <= 6; seq++) {
      await expect(coordinator.run(wake("a1", "/s/c", seq), dispatch)).resolves.toMatchObject({
        state: "suppressed",
      });
    }
    expect(dispatch.mock.calls.map(([command]) => command.unreadNotice.latestSeq)).toEqual([1, 2]);

    coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#6" }], 0);
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("re-arms one active delivery when a pull covers the admitted wake but not a newer desired watermark", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async (command: Wake) => {
      coordinator.recordDeliveryAck(command.agentId, command.launchId, "ok");
    });

    await coordinator.run(wake("a1", "/s/c", 1), dispatch);
    coordinator.recordAgentActivity("a1", "running");
    coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#1" }], 0);
    await coordinator.run(wake("a1", "/s/c", 2), dispatch);
    await coordinator.run(wake("a1", "/s/c", 3), dispatch);
    expect(dispatch.mock.calls.map(([command]) => command.unreadNotice.latestSeq)).toEqual([1, 2]);

    coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#2" }], 0);
    await tick();
    expect(dispatch.mock.calls.map(([command]) => command.unreadNotice.latestSeq)).toEqual([1, 2, 3]);
  });

  it("keeps a later channel covered when the active reminder pull observes only an earlier channel", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async (command: Wake) => {
      coordinator.recordDeliveryAck(command.agentId, command.launchId, "ok");
    });

    await coordinator.run(wake("a1", "/s/root", 1), dispatch);
    coordinator.recordAgentActivity("a1", "running");
    coordinator.recordModelSeen("a1", [{ channel: "/s/root", seq: "#1" }], 0);

    await coordinator.run(wake("a1", "/s/c1", 2), dispatch);
    await coordinator.run(wake("a1", "/s/c2", 7), dispatch);
    expect(dispatch.mock.calls.map(([command]) => command.unreadNotice.channel)).toEqual(["/s/root", "/s/c1"]);

    coordinator.recordModelSeen("a1", [{ channel: "/s/c1", seq: "#2" }], 0);
    await tick();
    expect(dispatch.mock.calls.map(([command]) => command.unreadNotice.channel)).toEqual([
      "/s/root",
      "/s/c1",
      "/s/c2",
    ]);
  });

  it("re-arms an unseen channel when a multi-channel admission pull observes only its sibling", async () => {
    const coordinator = new WakeCoordinator();
    let releaseInitial!: () => void;
    const initialBlocked = new Promise<void>((resolve) => { releaseInitial = resolve; });
    const dispatch = vi.fn(async (command: Wake) => {
      coordinator.recordDeliveryAck(command.agentId, command.launchId, "ok");
      if (command.launchId === "initial") await initialBlocked;
    });

    const initial = coordinator.run(wake("a1", "/s/root", 1, "initial"), dispatch);
    await tick();
    await coordinator.run(wake("a1", "/s/c1", 2, "c1"), dispatch);
    await coordinator.run(wake("a1", "/s/c2", 7, "c2"), dispatch);
    coordinator.recordModelSeen("a1", [{ channel: "/s/root", seq: "#1" }], 0);
    releaseInitial();
    await initial;

    expect(dispatch.mock.calls.map(([command]) => command.unreadNotice.channel)).toEqual([
      "/s/root",
      "/s/c2",
    ]);

    coordinator.recordModelSeen("a1", [{ channel: "/s/c1", seq: "#2" }], 0);
    await tick();
    expect(dispatch.mock.calls.map(([command]) => command.unreadNotice.channel)).toEqual([
      "/s/root",
      "/s/c2",
      "/s/c2",
    ]);

    coordinator.recordModelSeen("a1", [{ channel: "/s/c2", seq: "#7" }], 0);
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("replaces a failed working delivery without dropping the runtime-active lane", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async (command: Wake) => {
      if (command.launchId === "initial") coordinator.recordDeliveryAck("a1", "initial", "ok");
    });

    await coordinator.run(wake("a1", "/s/c", 1, "initial"), dispatch);
    coordinator.recordAgentActivity("a1", "running");
    coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#1" }], 0);

    await coordinator.run(wake("a1", "/s/c", 2, "working_failed"), dispatch);
    await coordinator.run(wake("a1", "/s/c", 3, "working_replacement"), dispatch);
    coordinator.recordDeliveryAck("a1", "working_failed", "error");
    await tick();

    expect(dispatch.mock.calls.map(([command]) => command.launchId)).toEqual([
      "initial",
      "working_failed",
      "working_replacement",
    ]);
  });

  it("reconciles a pending active wake when model-seen beats the delivery ack", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async () => {});

    await coordinator.run(wake("a1", "/s/c", 1, "launch_1"), dispatch);
    coordinator.recordAgentActivity("a1", "running");
    coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#1" }], 0);
    await coordinator.run(wake("a1", "/s/c", 2, "launch_2"), dispatch);
    expect(dispatch.mock.calls.map(([command]) => command.launchId)).toEqual(["launch_1"]);

    coordinator.recordDeliveryAck("a1", "launch_1", "ok");
    await tick();
    expect(dispatch.mock.calls.map(([command]) => command.launchId)).toEqual(["launch_1", "launch_2"]);
  });

  it("lets the first reminder pull cover a higher pre-observation burst even when its ack is delayed", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async () => {});
    await coordinator.run(wake("a1", "/s/c", 5, "initial"), dispatch);
    await coordinator.run(wake("a1", "/s/c", 6), dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const generation = coordinator.modelSeenGeneration("a1");
    expect(coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#6" }], generation)).toBe(true);
    coordinator.recordDeliveryAck("a1", "initial", "ok");
    coordinator.recordAgentActivity("a1", "idle");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not strand an acknowledged but unobserved admission across idle", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async (command: Wake) => {
      coordinator.recordDeliveryAck(command.agentId, command.launchId, "ok");
    });

    await coordinator.run(wake("a1", "/s/c", 5, "initial"), dispatch);
    coordinator.recordAgentActivity("a1", "idle");
    await tick();
    await coordinator.run(wake("a1", "/s/c", 5, "durable_retry"), dispatch);
    await tick();

    expect(dispatch).toHaveBeenCalledTimes(2);

    coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#5" }], 0);
    coordinator.recordAgentActivity("a1", "idle");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not strand an unobserved admission when idle precedes its delivery ack", async () => {
    const coordinator = new WakeCoordinator();
    let releaseInitial!: () => void;
    const initialBlocked = new Promise<void>((resolve) => { releaseInitial = resolve; });
    const dispatch = vi.fn(async (command: Wake) => {
      if (command.launchId === "initial") await initialBlocked;
      coordinator.recordDeliveryAck(command.agentId, command.launchId, "ok");
    });

    const initial = coordinator.run(wake("a1", "/s/c", 5, "initial"), dispatch);
    await tick();
    coordinator.recordAgentActivity("a1", "idle");
    releaseInitial();
    await initial;
    await coordinator.run(wake("a1", "/s/c", 5, "durable_retry"), dispatch);
    await tick();

    expect(dispatch).toHaveBeenCalledTimes(2);

    coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#5" }], 0);
    coordinator.recordAgentActivity("a1", "idle");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("suppresses an old wake when inbox pull arrived first", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async () => {});
    coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#9" }], 0);
    await expect(coordinator.run(wake("a1", "/s/c", 9), dispatch)).resolves.toEqual({
      state: "suppressed",
      coveredSeq: 9,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("admits a higher seq after pull coverage and idle", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async () => {});
    coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#5" }], 0);
    coordinator.recordAgentActivity("a1", "idle");
    await expect(coordinator.run(wake("a1", "/s/c", 6), dispatch)).resolves.toEqual({ state: "accepted" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("re-arms after an error wake ack", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async () => {});
    await coordinator.run(wake("a1", "/s/c", 5, "failed"), dispatch);
    coordinator.recordDeliveryAck("a1", "failed", "error");
    await coordinator.run(wake("a1", "/s/c", 5, "retry"), dispatch);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("fences a pull that began before stop while preserving committed seen", () => {
    const coordinator = new WakeCoordinator();
    coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#3" }], 0);
    const staleGeneration = coordinator.modelSeenGeneration("a1");
    coordinator.invalidate("a1", false);
    expect(coordinator.recordModelSeen("a1", [{ channel: "/s/c", seq: "#8" }], staleGeneration)).toBe(false);
    expect(coordinator.modelSeenGeneration("a1")).toBe(1);
  });

  it("keeps different agents independent", async () => {
    const coordinator = new WakeCoordinator();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatchA = vi.fn(async () => blocked);
    const dispatchB = vi.fn(async () => {});
    const first = coordinator.run(wake("a1", "/s/c", 1), dispatchA);
    await tick();
    await expect(coordinator.run(wake("a2", "/s/c", 1), dispatchB)).resolves.toEqual({ state: "accepted" });
    expect(dispatchB).toHaveBeenCalledOnce();
    release();
    await first;
  });

  it("admits the same desired vector only once across repeated idle transitions", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async () => {});
    await coordinator.run(wake("a1", "/s/c", 5), dispatch);
    await coordinator.run(wake("a1", "/s/c", 6), dispatch);
    coordinator.recordAgentActivity("a1", "idle");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
    coordinator.recordAgentActivity("a1", "running");
    coordinator.recordAgentActivity("a1", "idle");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("suppresses a same-seq duplicate after compensation admission", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async () => {});
    await coordinator.run(wake("a1", "/s/c", 5), dispatch);
    await coordinator.run(wake("a1", "/s/c", 6), dispatch);
    coordinator.recordAgentActivity("a1", "idle");
    await tick();

    await expect(coordinator.run(wake("a1", "/s/c", 6, "duplicate"), dispatch)).resolves.toEqual({
      state: "suppressed",
      coveredSeq: 6,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not re-admit a pending vector after an unrelated pull", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async () => {});
    await coordinator.run(wake("a1", "/s/c1", 1), dispatch);
    await coordinator.run(wake("a1", "/s/c1", 2), dispatch);
    coordinator.recordAgentActivity("a1", "idle");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);

    const generation = coordinator.modelSeenGeneration("a1");
    coordinator.recordModelSeen("a1", [{ channel: "/s/unrelated", seq: "#9" }], generation);
    coordinator.recordAgentActivity("a1", "running");
    coordinator.recordAgentActivity("a1", "idle");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("covers every pending channel in one agent admission", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async () => {});
    await coordinator.run(wake("a1", "/s/c0", 1), dispatch);
    await coordinator.run(wake("a1", "/s/c1", 5), dispatch);
    await coordinator.run(wake("a1", "/s/c2", 7), dispatch);

    coordinator.recordAgentActivity("a1", "idle");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
    coordinator.recordAgentActivity("a1", "running");
    coordinator.recordAgentActivity("a1", "idle");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("rolls back an errored admission vector without reviving an old covered launch", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async () => {});
    await coordinator.run(wake("a1", "/s/c0", 1), dispatch);
    await coordinator.run(wake("a1", "/s/c1", 5), dispatch);
    await coordinator.run(wake("a1", "/s/c2", 7, "compensation"), dispatch);
    coordinator.recordAgentActivity("a1", "idle");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);

    coordinator.recordDeliveryAck("a1", "compensation", "error");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
    await expect(coordinator.run(wake("a1", "/s/c1", 5, "retry"), dispatch)).resolves.toEqual({
      state: "accepted",
    });
    expect(dispatch).toHaveBeenCalledTimes(3);
    await expect(coordinator.run(wake("a1", "/s/c2", 7, "duplicate"), dispatch)).resolves.toEqual({
      state: "suppressed",
      coveredSeq: 7,
    });
  });

  it("auto-admits a different-launch wake coalesced behind a failed provisional admission", async () => {
    const coordinator = new WakeCoordinator();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = vi.fn(async (command: Wake) => {
      if (command.launchId === "launch_a") await blocked;
    });

    const first = coordinator.run(wake("a1", "/s/c", 5, "launch_a"), dispatch);
    await tick();
    await expect(coordinator.run(wake("a1", "/s/c", 5, "launch_b"), dispatch)).resolves.toMatchObject({
      state: "suppressed",
    });
    coordinator.recordDeliveryAck("a1", "launch_a", "error");
    expect(dispatch).toHaveBeenCalledTimes(1);
    release();
    await first;

    expect(dispatch.mock.calls.map(([command]) => command.launchId)).toEqual(["launch_a", "launch_b"]);
  });

  it("does not let a stale lower-seq launch replace the current retry candidate", async () => {
    const coordinator = new WakeCoordinator();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = vi.fn(async (command: Wake) => {
      if (command.launchId === "launch_a") await blocked;
    });

    const first = coordinator.run(wake("a1", "/s/c", 5, "launch_a"), dispatch);
    await tick();
    await coordinator.run(wake("a1", "/s/c", 5, "launch_b"), dispatch);
    await coordinator.run(wake("a1", "/s/c", 4, "launch_c"), dispatch);
    coordinator.recordDeliveryAck("a1", "launch_a", "error");
    release();
    await first;

    expect(dispatch.mock.calls.map(([command]) => command.launchId)).toEqual(["launch_a", "launch_b"]);
  });

  it("fences a rejected old admission from a new lifecycle admission", async () => {
    const coordinator = new WakeCoordinator();
    let rejectA!: (error: Error) => void;
    let releaseB!: () => void;
    const blockedA = new Promise<void>((_resolve, reject) => { rejectA = reject; });
    const blockedB = new Promise<void>((resolve) => { releaseB = resolve; });
    const dispatch = vi.fn(async (command: Wake) => {
      if (command.launchId === "launch_a") await blockedA;
      if (command.launchId === "launch_b") await blockedB;
    });

    const first = coordinator.run(wake("a1", "/s/c", 5, "launch_a"), dispatch);
    await tick();
    coordinator.invalidate("a1", true);
    const second = coordinator.run(wake("a1", "/s/c", 6, "launch_b"), dispatch);
    await tick();
    await coordinator.run(wake("a1", "/s/c", 6, "launch_c"), dispatch);

    rejectA(new Error("old lifecycle failed"));
    await expect(first).rejects.toThrow("old lifecycle failed");
    expect(dispatch.mock.calls.map(([command]) => command.launchId)).toEqual(["launch_a", "launch_b"]);

    coordinator.recordDeliveryAck("a1", "launch_b", "error");
    releaseB();
    await second;
    expect(dispatch.mock.calls.map(([command]) => command.launchId)).toEqual([
      "launch_a",
      "launch_b",
      "launch_c",
    ]);
  });

  it("reconciles pending desired work when idle arrives before dispatch returns", async () => {
    const coordinator = new WakeCoordinator();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = vi.fn(async (command: Wake) => {
      if (command.launchId === "launch_a") await blocked;
    });

    const first = coordinator.run(wake("a1", "/s/c", 5, "launch_a"), dispatch);
    await tick();
    await coordinator.run(wake("a1", "/s/c", 6, "launch_b"), dispatch);
    coordinator.recordAgentActivity("a1", "idle");
    release();
    await first;

    expect(dispatch.mock.calls.map(([command]) => command.launchId)).toEqual(["launch_a", "launch_b"]);
  });

  it("does not spin-retry a permanently failed admission without a different launch", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async (command: Wake) => {
      coordinator.recordDeliveryAck(command.agentId, command.launchId, "error");
    });

    await coordinator.run(wake("a1", "/s/c", 5, "launch_a"), dispatch);
    coordinator.recordAgentActivity("a1", "idle");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to the old failed launch when its replacement also fails", async () => {
    const coordinator = new WakeCoordinator();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = vi.fn(async (command: Wake) => {
      if (command.launchId === "launch_a") {
        await blocked;
      } else {
        coordinator.recordDeliveryAck(command.agentId, command.launchId, "error");
      }
    });

    const first = coordinator.run(wake("a1", "/s/c", 5, "launch_a"), dispatch);
    await tick();
    await coordinator.run(wake("a1", "/s/c", 5, "launch_b"), dispatch);
    coordinator.recordDeliveryAck("a1", "launch_a", "error");
    release();
    await first;
    coordinator.recordAgentActivity("a1", "idle");
    await tick();

    expect(dispatch.mock.calls.map(([command]) => command.launchId)).toEqual(["launch_a", "launch_b"]);
  });

  it("bounds automatic retries when covered launches on different channels both fail", async () => {
    const coordinator = new WakeCoordinator();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = vi.fn(async (command: Wake) => {
      if (command.launchId === "launch_a") await blocked;
      coordinator.recordDeliveryAck(command.agentId, command.launchId, "error");
    });

    const first = coordinator.run(wake("a1", "/s/c1", 5, "launch_a"), dispatch);
    await tick();
    await coordinator.run(wake("a1", "/s/c2", 7, "launch_b"), dispatch);
    release();
    await first;
    await tick();

    expect(dispatch.mock.calls.map(([command]) => command.launchId)).toEqual(["launch_a", "launch_b"]);
  });

  it("keeps failed-launch tracking bounded across unique external re-arms", async () => {
    const coordinator = new WakeCoordinator();
    const dispatch = vi.fn(async (command: Wake) => {
      coordinator.recordDeliveryAck(command.agentId, command.launchId, "error");
    });

    for (let attempt = 1; attempt <= 100; attempt++) {
      await coordinator.run(wake("a1", "/s/c", 5, `launch_${attempt}`), dispatch);
    }
    coordinator.recordAgentActivity("a1", "idle");
    await tick();

    expect(dispatch).toHaveBeenCalledTimes(100);
  });
});
