import { describe, it, expect } from "vitest";
import { CommunityWsEventSchema, isCommunityEvent, WS_EVENTS } from "../src/community-ws-events";
import type {
  CommunityChannelDelete,
  CommunityMessageEdited,
  CommunityMachineCreated,
  CommunityMachineUpdated,
  CommunityMachineSummary,
} from "../src/community-ws-events";

describe("CommunityChannelDelete post-unit address contract", () => {
  it("accepts canonical post identity while preserving legacy/top-level compatibility", () => {
    const canonical: CommunityChannelDelete = {
      type: "community:channel.delete",
      serverId: "server_1",
      channelId: "child_1",
      parentChannelId: "forum_1",
      parentMessageId: "opener_1",
    };
    expect(CommunityWsEventSchema.parse(canonical)).toEqual(canonical);
    expect(CommunityWsEventSchema.safeParse({
      type: "community:channel.delete",
      serverId: "server_1",
      channelId: "channel_1",
    }).success).toBe(true);
  });

  it("keeps the frame strict", () => {
    expect(CommunityWsEventSchema.safeParse({
      type: "community:channel.delete",
      serverId: "server_1",
      channelId: "child_1",
      parentChannelId: "forum_1",
      parentMessageId: 42,
    }).success).toBe(false);
    for (const parentChannelId of [undefined, null, ""]) {
      expect(CommunityWsEventSchema.safeParse({
        type: "community:channel.delete",
        serverId: "server_1",
        channelId: "child_1",
        ...(parentChannelId !== undefined ? { parentChannelId } : {}),
        parentMessageId: "opener_1",
      }).success).toBe(false);
    }
    expect(CommunityWsEventSchema.safeParse({
      type: "community:channel.delete",
      serverId: "server_1",
      channelId: "child_1",
      parentChannelId: "forum_1",
    }).success).toBe(true);
  });
});

describe("CommunityMessageEdited address contract", () => {
  it("supports forum opener, ordinary server, and DM edits", () => {
    const events: CommunityMessageEdited[] = [
      { type: "community:message.edited", channelId: "post", parentChannelId: "forum", serverId: "server", messageId: "opener", content: "new" },
      { type: "community:message.edited", channelId: "text", serverId: "server", messageId: "message", content: "new" },
      { type: "community:message.edited", channelId: "dm", messageId: "message", content: "new" },
    ];
    expect(events).toHaveLength(3);
  });
});

describe("isCommunityEvent", () => {
  it("accepts every exact event declared by WS_EVENTS", () => {
    expect(Object.values(WS_EVENTS)).toHaveLength(45);
    for (const type of Object.values(WS_EVENTS)) {
      expect(isCommunityEvent({ type })).toBe(true);
    }
  });

  it("rejects unknown, approximate, and non-community event names", () => {
    expect(isCommunityEvent({ type: "community:unknown" })).toBe(false);
    expect(isCommunityEvent({ type: "community:message.create.extra" })).toBe(false);
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
