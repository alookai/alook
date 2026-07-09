import { describe, it, expect } from "vitest";
import { isCommunityEvent } from "../src/community-ws-events";
import type {
  CommunityMachineCreated,
  CommunityMachineUpdated,
  CommunityMachineSummary,
} from "../src/community-ws-events";

describe("isCommunityEvent", () => {
  it("returns true for community:machine.created", () => {
    expect(isCommunityEvent({ type: "community:machine.created" })).toBe(true);
  });
  it("returns true for community:machine.status", () => {
    expect(isCommunityEvent({ type: "community:machine.status" })).toBe(true);
  });
  it("returns true for community:machine.updated", () => {
    expect(isCommunityEvent({ type: "community:machine.updated" })).toBe(true);
  });
  it("returns true for community:machine.removed", () => {
    expect(isCommunityEvent({ type: "community:machine.removed" })).toBe(true);
  });
  it("returns false for non-community events", () => {
    expect(isCommunityEvent({ type: "foo:bar" })).toBe(false);
    expect(isCommunityEvent({ type: "runtime.status" })).toBe(false);
  });
});

describe("CommunityMachineSummary.availableRuntimes", () => {
  it("is typed and JSON-serializable on machine.created", () => {
    const summary: CommunityMachineSummary = {
      id: "cm_1",
      hostname: "host",
      displayName: "host",
      platform: "darwin",
      arch: "arm64",
      osRelease: "23",
      daemonVersion: "0.1.0",
      lastSeenAt: null,
      status: "offline",
      availableRuntimes: [{ id: "claude", version: "1.0.0" }, { id: "codex" }],
      createdAt: "t",
      updatedAt: "t",
    };
    const event: CommunityMachineCreated = {
      type: "community:machine.created",
      machine: summary,
      tokenId: "cmt_x",
    };
    const round = JSON.parse(JSON.stringify(event)) as CommunityMachineCreated;
    expect(round.machine.availableRuntimes).toEqual([
      { id: "claude", version: "1.0.0" },
      { id: "codex" },
    ]);
  });

  it("carries availableRuntimes on machine.updated", () => {
    const updated: CommunityMachineUpdated = {
      type: "community:machine.updated",
      machine: {
        id: "cm_1",
        hostname: "host",
        displayName: "host",
        platform: "darwin",
        arch: "arm64",
        osRelease: "23",
        daemonVersion: "0.1.0",
        lastSeenAt: null,
        status: "offline",
        availableRuntimes: [{ id: "claude" }],
        createdAt: "t",
        updatedAt: "t",
      },
    };
    expect(updated.machine.availableRuntimes).toHaveLength(1);
  });
});
