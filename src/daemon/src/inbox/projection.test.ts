import { describe, it, expect } from "vitest";
import { projectAgentInboxSnapshot, formatInboxMessageTarget, type InboxMessage } from "./projection";

describe("formatInboxMessageTarget", () => {
  it("formats channel / dm / thread targets", () => {
    expect(formatInboxMessageTarget({ channel_type: "channel", channel_name: "general" })).toBe("#general");
    expect(formatInboxMessageTarget({ channel_type: "dm", channel_name: "gustavo" })).toBe("dm:@gustavo");
    expect(
      formatInboxMessageTarget({
        channel_type: "thread",
        parent_channel_type: "channel",
        parent_channel_name: "general",
        channel_name: "thread-abcdef12",
      }),
    ).toMatch(/^#general:/);
  });
  it("returns null when there's no channel name", () => {
    expect(formatInboxMessageTarget({ channel_type: "channel" })).toBeNull();
  });
});

describe("projectAgentInboxSnapshot", () => {
  it("buckets by target and counts pending", () => {
    const msgs: InboxMessage[] = [
      { channel_type: "channel", channel_name: "general", seq: 1, sender_name: "a" },
      { channel_type: "channel", channel_name: "general", seq: 2, sender_name: "b" },
      { channel_type: "dm", channel_name: "gustavo", seq: 5, sender_name: "gustavo" },
    ];
    const snap = projectAgentInboxSnapshot(msgs);
    const general = snap.find((s) => s.target === "#general")!;
    const dm = snap.find((s) => s.target === "dm:@gustavo")!;
    expect(general.pendingCount).toBe(2);
    expect(general.firstPendingSeq).toBe(1);
    expect(general.latestSeq).toBe(2);
    expect(dm.pendingCount).toBe(1);
    expect(dm.flags).toContain("dm");
  });

  it("sorts buckets by latestSeq desc", () => {
    const msgs: InboxMessage[] = [
      { channel_type: "channel", channel_name: "low", seq: 1 },
      { channel_type: "channel", channel_name: "high", seq: 99 },
    ];
    const snap = projectAgentInboxSnapshot(msgs);
    expect(snap[0].target).toBe("#high");
  });

  it("sets task + mention flags", () => {
    const msgs: InboxMessage[] = [
      { channel_type: "channel", channel_name: "general", seq: 1, task_number: 3, mention: true },
    ];
    const [snap] = projectAgentInboxSnapshot(msgs);
    expect(snap.flags).toContain("task");
    expect(snap.flags).toContain("mention");
  });

  it("ignores messages with no resolvable target", () => {
    expect(projectAgentInboxSnapshot([{ seq: 1 }])).toEqual([]);
  });
});
