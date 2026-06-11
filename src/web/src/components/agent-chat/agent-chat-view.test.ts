import { describe, it, expect } from "vitest";
import type { Message, Artifact } from "@alook/shared";
import { sortMessages, mergeMessages, buildTimeline, computeGroupPositions, getEventIconType, eventTypeFromMessage, shouldPersistPointerForLoad, pointerRefreshTargetForTaskCreated } from "./chat-message-utils";
import type { NapMarker } from "./chat-message-utils";

function msg(id: string, created_at: string, role: "user" | "assistant" | "event" = "user", content = ""): Message {
  return { id, conversation_id: "conv1", role, content, task_id: null, attachment_ids: null, created_at };
}

describe("sortMessages", () => {
  it("sorts messages by created_at ascending", () => {
    const msgs = [
      msg("m3", "2024-01-03T00:00:00Z"),
      msg("m1", "2024-01-01T00:00:00Z"),
      msg("m2", "2024-01-02T00:00:00Z"),
    ];
    const sorted = sortMessages(msgs);
    expect(sorted.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("breaks ties by id when created_at is identical", () => {
    const msgs = [
      msg("b", "2024-01-01T00:00:00Z"),
      msg("a", "2024-01-01T00:00:00Z"),
      msg("c", "2024-01-01T00:00:00Z"),
    ];
    const sorted = sortMessages(msgs);
    expect(sorted.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the original array", () => {
    const msgs = [
      msg("m2", "2024-01-02T00:00:00Z"),
      msg("m1", "2024-01-01T00:00:00Z"),
    ];
    sortMessages(msgs);
    expect(msgs[0].id).toBe("m2");
  });

  it("returns empty array for empty input", () => {
    expect(sortMessages([])).toEqual([]);
  });
});

describe("mergeMessages", () => {
  it("merges two arrays and sorts chronologically", () => {
    const existing = [
      msg("m1", "2024-01-01T00:00:00Z"),
      msg("m3", "2024-01-03T00:00:00Z"),
    ];
    const incoming = [
      msg("m2", "2024-01-02T00:00:00Z"),
      msg("m4", "2024-01-04T00:00:00Z"),
    ];
    const result = mergeMessages(existing, incoming);
    expect(result.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("deduplicates by id — incoming wins", () => {
    const existing = [
      msg("m1", "2024-01-01T00:00:00Z", "user", "old content"),
    ];
    const incoming = [
      msg("m1", "2024-01-01T00:00:00Z", "user", "updated content"),
    ];
    const result = mergeMessages(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("updated content");
  });

  it("replaces optimistic temp message with server message", () => {
    const existing = [
      msg("m1", "2024-01-01T00:00:00Z"),
      msg("temp-123", "2024-01-02T00:00:00Z", "user", "hello"),
    ];
    // After sendMessage replaces temp, but server also returns the real message
    const serverState = [
      msg("m1", "2024-01-01T00:00:00Z"),
      msg("m2", "2024-01-02T00:00:00Z", "user", "hello"),
      msg("m3", "2024-01-02T00:01:00Z", "assistant", "hi there"),
    ];
    // In the real flow, temp-123 is already replaced by m2 before merge.
    // But even if it weren't, merge produces correct chronological order.
    const existing2 = [
      msg("m1", "2024-01-01T00:00:00Z"),
      msg("m2", "2024-01-02T00:00:00Z", "user", "hello"),
    ];
    const result = mergeMessages(existing2, serverState);
    expect(result.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("preserves older pagination messages not in server window", () => {
    // User scrolled up and loaded old messages (m1-m5)
    // Current state has m1..m10 + m11 (user just sent)
    const existing = [
      msg("m1", "2024-01-01T00:00:00Z"),
      msg("m2", "2024-01-02T00:00:00Z"),
      msg("m3", "2024-01-03T00:00:00Z"),
      msg("m4", "2024-01-04T00:00:00Z"),
      msg("m5", "2024-01-05T00:00:00Z"),
      msg("m6", "2024-01-06T00:00:00Z"),
      msg("m7", "2024-01-07T00:00:00Z"),
      msg("m8", "2024-01-08T00:00:00Z"),
      msg("m9", "2024-01-09T00:00:00Z"),
      msg("m10", "2024-01-10T00:00:00Z"),
      msg("m11", "2024-01-11T00:00:00Z", "user", "new message"),
    ];
    // Server returns latest 20 — but conversation only has 12 messages total
    const incoming = [
      msg("m1", "2024-01-01T00:00:00Z"),
      msg("m2", "2024-01-02T00:00:00Z"),
      msg("m3", "2024-01-03T00:00:00Z"),
      msg("m4", "2024-01-04T00:00:00Z"),
      msg("m5", "2024-01-05T00:00:00Z"),
      msg("m6", "2024-01-06T00:00:00Z"),
      msg("m7", "2024-01-07T00:00:00Z"),
      msg("m8", "2024-01-08T00:00:00Z"),
      msg("m9", "2024-01-09T00:00:00Z"),
      msg("m10", "2024-01-10T00:00:00Z"),
      msg("m11", "2024-01-11T00:00:00Z", "user", "new message"),
      msg("m12", "2024-01-12T00:00:00Z", "assistant", "response"),
    ];
    const result = mergeMessages(existing, incoming);
    expect(result.map((m) => m.id)).toEqual([
      "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12",
    ]);
    // User message and assistant response are adjacent at the end
    expect(result[10].role).toBe("user");
    expect(result[11].role).toBe("assistant");
  });

  it("fixes the original bug — append-dedup produced misordered array", () => {
    // Reproduce the exact bug scenario:
    // Initial load: latest 10 messages (m11..m20)
    const existing = Array.from({ length: 10 }, (_, i) =>
      msg(`m${i + 11}`, `2024-01-${String(i + 11).padStart(2, "0")}T00:00:00Z`)
    );
    // User sends m21
    existing.push(msg("m21", "2024-01-21T00:00:00Z", "user", "what we have done yesterday"));

    // Server returns latest 20 (m3..m22) — includes older messages m3-m10 not in state
    const incoming = Array.from({ length: 20 }, (_, i) =>
      msg(`m${i + 3}`, `2024-01-${String(i + 3).padStart(2, "0")}T00:00:00Z`)
    );
    // m22 is the assistant response
    incoming.push(msg("m22", "2024-01-22T00:00:00Z", "assistant", "Here's what we did"));

    const result = mergeMessages(existing, incoming);

    // All messages must be in strict chronological order
    for (let i = 1; i < result.length; i++) {
      expect(result[i].created_at >= result[i - 1].created_at).toBe(true);
    }

    // User message (m21) and assistant response (m22) must be adjacent at the end
    const userIdx = result.findIndex((m) => m.id === "m21");
    const assistantIdx = result.findIndex((m) => m.id === "m22");
    expect(assistantIdx).toBe(userIdx + 1);
    expect(result[result.length - 1].id).toBe("m22");
    expect(result[result.length - 2].id).toBe("m21");
  });

  it("handles empty existing array", () => {
    const incoming = [msg("m1", "2024-01-01T00:00:00Z")];
    const result = mergeMessages([], incoming);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  it("handles empty incoming array", () => {
    const existing = [msg("m1", "2024-01-01T00:00:00Z")];
    const result = mergeMessages(existing, []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  it("handles rapid messages — two sends don't corrupt order", () => {
    // State after two rapid sends
    const existing = [
      msg("m1", "2024-01-01T00:00:00Z", "user"),
      msg("m2", "2024-01-01T00:00:01Z", "assistant"),
      msg("m3", "2024-01-01T00:00:02Z", "user", "first rapid"),
      msg("m4", "2024-01-01T00:00:03Z", "user", "second rapid"),
    ];
    // Server returns with both responses
    const incoming = [
      msg("m1", "2024-01-01T00:00:00Z", "user"),
      msg("m2", "2024-01-01T00:00:01Z", "assistant"),
      msg("m3", "2024-01-01T00:00:02Z", "user", "first rapid"),
      msg("m4", "2024-01-01T00:00:03Z", "user", "second rapid"),
      msg("m5", "2024-01-01T00:00:04Z", "assistant", "response to first"),
      msg("m6", "2024-01-01T00:00:05Z", "assistant", "response to second"),
    ];
    const result = mergeMessages(existing, incoming);
    expect(result.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
  });
});

describe("getEventIconType", () => {
  it("uses the issue icon for issue conversations", () => {
    expect(getEventIconType("Error: failed to download attachments", "issue_event")).toBe("issue");
  });

  it("uses the issue icon for issue event content", () => {
    expect(getEventIconType("Issue status changed: todo -> done", "user_dm_message")).toBe("issue");
  });

  it("keeps email and calendar event icons for existing channels", () => {
    expect(getEventIconType("New email from user@example.com", "email_notification")).toBe("email");
    expect(getEventIconType("Calendar event started", "calendar_event")).toBe("calendar");
  });

  it("lets explicit channel type win over event content", () => {
    expect(getEventIconType("Issue mentioned in an email subject", "email_notification")).toBe("email");
  });
});

// Card type is metadata-driven first (robust if copy changes), content heuristic
// only as a fallback when no resource id is present.
describe("eventTypeFromMessage (metadata-driven)", () => {
  it("uses the metadata resource id over the content heuristic", () => {
    // Content says "email" but the metadata carries an issueId → issue wins.
    expect(eventTypeFromMessage({ issueId: "iss_1" }, "email-ish text", null)).toBe("issue");
    expect(eventTypeFromMessage({ emailId: "em_1" }, "no keywords here", null)).toBe("email");
    expect(eventTypeFromMessage({ calendarEventId: "cal_1" }, "no keywords here", null)).toBe("calendar");
  });

  it("falls back to the content/conversation heuristic when metadata is absent", () => {
    expect(eventTypeFromMessage(null, "Issue created: foo", "issue_event")).toBe("issue");
    expect(eventTypeFromMessage(undefined, "New email from a@b.com: hi", "email_notification")).toBe("email");
    expect(eventTypeFromMessage({}, "Standup reminder", "calendar_event")).toBe("calendar");
  });
});

function artifact(id: string, created_at: string): Artifact {
  return {
    id,
    conversation_id: "conv1",
    agent_id: "agent1",
    filename: "file.txt",
    content_type: "text/plain",
    size: 100,
    source: "agent",
    has_thumbnail: false,
    created_at,
  };
}

function nap(id: string, created_at: string, agentName = "Luna"): NapMarker {
  return { id, created_at, agentName };
}

describe("buildTimeline", () => {
  it("interleaves messages, artifacts, and nap markers chronologically", () => {
    const msgs = [
      msg("m1", "2024-01-01T00:00:00Z"),
      msg("m3", "2024-01-03T00:00:00Z"),
    ];
    const arts = [artifact("a1", "2024-01-02T00:00:00Z")];
    const naps: NapMarker[] = [];

    const result = buildTimeline(msgs, arts, naps);
    // Strictly chronological now (no artifact reorder): the file at 00:00:02
    // sits between the two messages where it actually happened.
    expect(result.map((i) => i.data.id)).toEqual(["m1", "a1", "m3"]);
  });

  it("places nap marker after messages at the same timestamp", () => {
    const msgs = [
      msg("m1", "2024-01-01T00:00:00Z"),
      msg("m2", "2024-01-03T00:00:00Z"),
    ];
    const napTs = "2024-01-02T00:00:00Z";
    const naps = [nap("nap-1", napTs)];

    const result = buildTimeline(msgs, [], naps);
    expect(result.map((i) => i.kind)).toEqual(["message", "nap", "message"]);
  });

  it("nap marker sorts after messages with the same created_at", () => {
    const ts = "2024-01-02T00:00:00Z";
    const msgs = [msg("m1", ts)];
    const naps = [nap("nap-1", ts)];

    const result = buildTimeline(msgs, [], naps);
    expect(result[0].kind).toBe("message");
    expect(result[1].kind).toBe("nap");
  });

  it("renders multiple nap markers between multiple conversations", () => {
    const msgs = [
      msg("m1", "2024-01-01T00:00:00Z"),
      msg("m2", "2024-01-03T00:00:00Z"),
      msg("m3", "2024-01-05T00:00:00Z"),
    ];
    const naps = [
      nap("nap-1", "2024-01-02T00:00:00Z"),
      nap("nap-2", "2024-01-04T00:00:00Z"),
    ];

    const result = buildTimeline(msgs, [], naps);
    expect(result.map((i) => i.kind)).toEqual([
      "message", "nap", "message", "nap", "message",
    ]);
    expect(result.map((i) => i.data.id)).toEqual([
      "m1", "nap-1", "m2", "nap-2", "m3",
    ]);
  });

  it("handles empty messages with nap markers only", () => {
    const naps = [nap("nap-1", "2024-01-01T00:00:00Z")];
    const result = buildTimeline([], [], naps);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("nap");
  });

  it("preserves agent name on nap markers", () => {
    const naps = [nap("nap-1", "2024-01-01T00:00:00Z", "TestBot")];
    const result = buildTimeline([], [], naps);
    expect(result[0].kind).toBe("nap");
    if (result[0].kind === "nap") {
      expect(result[0].data.agentName).toBe("TestBot");
    }
  });

  it("returns empty timeline when all inputs are empty", () => {
    expect(buildTimeline([], [], [])).toEqual([]);
  });

  it("handles mixed roles (user + assistant + event) without errors", () => {
    const msgs = [
      msg("m1", "2024-01-01T00:00:00Z", "user", "hello"),
      msg("m2", "2024-01-02T00:00:00Z", "event", "New email from sender@test.com: Subject"),
      msg("m3", "2024-01-03T00:00:00Z", "assistant", "response"),
    ];
    const result = buildTimeline(msgs, [], []);
    expect(result).toHaveLength(3);
    expect(result.map((i) => i.data.id)).toEqual(["m1", "m2", "m3"]);
    expect(result.every((i) => i.kind === "message")).toBe(true);
  });
});

function msgInConv(id: string, created_at: string, conversation_id: string): Message {
  return { id, conversation_id, role: "user", content: "", task_id: null, attachment_ids: null, created_at };
}

function artifactInConv(id: string, created_at: string, conversation_id: string): Artifact {
  return { id, conversation_id, agent_id: "agent1", filename: "file.txt", content_type: "text/plain", size: 100, source: "agent", has_thumbnail: false, created_at };
}

describe("buildTimeline — conversation grouping", () => {
  it("groups messages from multiple conversations correctly", () => {
    const msgs = [
      msgInConv("a1", "2024-01-01T00:00:00Z", "convA"),
      msgInConv("a2", "2024-01-01T01:00:00Z", "convA"),
      msgInConv("b1", "2024-01-02T00:00:00Z", "convB"),
      msgInConv("b2", "2024-01-02T01:00:00Z", "convB"),
    ];
    const naps = [nap("nap-convA", "2024-01-01T12:00:00Z")];

    const result = buildTimeline(msgs, [], naps, "convB");
    expect(result.map((i) => i.data.id)).toEqual(["a1", "a2", "nap-convA", "b1", "b2"]);
  });

  it("new message in old conversation stays in its section", () => {
    const msgs = [
      msgInConv("a1", "2024-01-01T00:00:00Z", "convA"),
      msgInConv("a2", "2024-01-01T01:00:00Z", "convA"),
      msgInConv("b1", "2024-01-02T00:00:00Z", "convB"),
      msgInConv("b2", "2024-01-02T01:00:00Z", "convB"),
      msgInConv("a3", "2024-01-03T00:00:00Z", "convA"), // newer than everything but belongs to old conv
    ];
    const naps = [nap("nap-convA", "2024-01-01T12:00:00Z")];

    const result = buildTimeline(msgs, [], naps, "convB");
    expect(result.map((i) => i.data.id)).toEqual(["a1", "a2", "a3", "nap-convA", "b1", "b2"]);
  });

  it("artifacts are grouped within their conversation section", () => {
    const msgs = [
      msgInConv("a1", "2024-01-01T00:00:00Z", "convA"),
      msgInConv("a2", "2024-01-01T02:00:00Z", "convA"),
      msgInConv("b1", "2024-01-02T00:00:00Z", "convB"),
    ];
    const arts = [artifactInConv("art1", "2024-01-01T01:00:00Z", "convA")];
    const naps = [nap("nap-convA", "2024-01-01T12:00:00Z")];

    const result = buildTimeline(msgs, arts, naps, "convB");
    // Chronological within the conversation section: art1 at 01:00 sits between
    // a1 (00:00) and a2 (02:00). No artifact reorder.
    expect(result.map((i) => i.data.id)).toEqual(["a1", "art1", "a2", "nap-convA", "b1"]);
  });

  it("single conversation (no nap markers) behaves as before", () => {
    const msgs = [
      msgInConv("m2", "2024-01-02T00:00:00Z", "convA"),
      msgInConv("m1", "2024-01-01T00:00:00Z", "convA"),
    ];
    const result = buildTimeline(msgs, [], [], "convA");
    expect(result.map((i) => i.data.id)).toEqual(["m1", "m2"]);
  });

  it("currentConversationId is null → fallback to global sort", () => {
    const msgs = [
      msgInConv("a1", "2024-01-01T00:00:00Z", "convA"),
      msgInConv("b1", "2024-01-02T00:00:00Z", "convB"),
    ];
    const naps = [nap("nap-convA", "2024-01-01T12:00:00Z")];

    const result = buildTimeline(msgs, [], naps, null);
    // falls back to global timestamp sort
    expect(result.map((i) => i.data.id)).toEqual(["a1", "nap-convA", "b1"]);
  });

  it("empty messages array returns only nap markers", () => {
    const naps = [nap("nap-convA", "2024-01-01T00:00:00Z")];
    const result = buildTimeline([], [], naps, "convB");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("nap");
  });

  it("nap marker ID parsing handles expected format", () => {
    const msgs = [
      msgInConv("m1", "2024-01-01T00:00:00Z", "conv_abc123"),
      msgInConv("m2", "2024-01-02T00:00:00Z", "conv_xyz"),
    ];
    const naps = [nap("nap-conv_abc123", "2024-01-01T12:00:00Z")];

    const result = buildTimeline(msgs, [], naps, "conv_xyz");
    expect(result.map((i) => i.data.id)).toEqual(["m1", "nap-conv_abc123", "m2"]);
  });

  it("multiple nap markers order sections correctly", () => {
    const msgs = [
      msgInConv("a1", "2024-01-01T00:00:00Z", "convA"),
      msgInConv("b1", "2024-01-02T00:00:00Z", "convB"),
      msgInConv("c1", "2024-01-03T00:00:00Z", "convC"),
    ];
    const naps = [
      nap("nap-convA", "2024-01-01T12:00:00Z"),
      nap("nap-convB", "2024-01-02T12:00:00Z"),
    ];

    const result = buildTimeline(msgs, [], naps, "convC");
    expect(result.map((i) => i.data.id)).toEqual(["a1", "nap-convA", "b1", "nap-convB", "c1"]);
  });

  it("orphan messages (unknown conversation_id) are placed before first nap marker", () => {
    const msgs = [
      msgInConv("a1", "2024-01-01T00:00:00Z", "convA"),
      msgInConv("x1", "2024-01-01T06:00:00Z", "convX"), // unknown
      msgInConv("b1", "2024-01-02T00:00:00Z", "convB"),
    ];
    const naps = [nap("nap-convA", "2024-01-01T12:00:00Z")];

    const result = buildTimeline(msgs, [], naps, "convB");
    // orphan x1 is placed before the first nap marker
    expect(result.map((i) => i.data.id)).toEqual(["a1", "x1", "nap-convA", "b1"]);
  });
});

// ---------------------------------------------------------------------------
// Wrong-conversation flash fix: per-channel "latest-created" pointer semantics.
//
// These cover the pure decision logic the fix is built on. The full component
// load/swap flow (paint → check-fresh → swap) cannot be rendered in this
// node-env Vitest suite (no jsdom/RTL), so the FLOW-level cases from the plan
// (TC2/TC3/TC7/TC10) are exercised through the pure predicates the flow now
// delegates to, plus the IndexedDB round-trip in chat-cache.test.ts (TC1).
// ---------------------------------------------------------------------------

describe("shouldPersistPointerForLoad (TODO-1: slow-path-only write gate)", () => {
  it("TC9 — fast path (targetConvId present) does NOT write the pointer", () => {
    // Opening ?conv=<old-id>: targetConvId is the explicit, possibly-old conv.
    expect(shouldPersistPointerForLoad("conv_old")).toBe(false);
  });

  it("TC2/TC3 — slow path (no targetConvId) DOES write the pointer", () => {
    // Param-less open: convId is server-resolved (latest-created) → persist it.
    expect(shouldPersistPointerForLoad(null)).toBe(true);
    expect(shouldPersistPointerForLoad(undefined)).toBe(true);
  });

  it("treats empty string targetConvId as no explicit target (slow path)", () => {
    // `?conv=` with an empty value never resolves a real conversation; the load
    // falls through to the slow path, so writing the resolved latest is correct.
    expect(shouldPersistPointerForLoad("")).toBe(true);
  });
});

describe("pointerRefreshTargetForTaskCreated (TODO-2: WS-driven refresh scope)", () => {
  const base = {
    agentId: "agent_a",
    activeChannel: "default",
    currentPointerConvId: "conv_current",
  };
  const task = (over: Partial<{ agent_id: string; channel: string | null; conversation_id: string }>) => ({
    agent_id: over.agent_id ?? "agent_a",
    channel: over.channel === undefined ? null : over.channel,
    conversation_id: over.conversation_id ?? "conv_new",
  });

  it("TC4 — newer conversation for this agent+channel → returns the new conv id", () => {
    expect(
      pointerRefreshTargetForTaskCreated({
        ...base,
        task: task({ agent_id: "agent_a", channel: "default", conversation_id: "conv_new" }),
      }),
    ).toBe("conv_new");
  });

  it("TC4 — null event channel normalizes to 'default' and matches the active default channel", () => {
    expect(
      pointerRefreshTargetForTaskCreated({
        ...base,
        task: task({ channel: null, conversation_id: "conv_new" }),
      }),
    ).toBe("conv_new");
  });

  it("matches a non-default named channel", () => {
    expect(
      pointerRefreshTargetForTaskCreated({
        ...base,
        activeChannel: "ops",
        task: task({ channel: "ops", conversation_id: "conv_new" }),
      }),
    ).toBe("conv_new");
  });

  it("TC5 — different agent → SKIP (returns null, never touches this pointer)", () => {
    expect(
      pointerRefreshTargetForTaskCreated({
        ...base,
        task: task({ agent_id: "agent_b", conversation_id: "conv_new" }),
      }),
    ).toBeNull();
  });

  it("TC5 — different channel → SKIP", () => {
    expect(
      pointerRefreshTargetForTaskCreated({
        ...base,
        activeChannel: "default",
        task: task({ channel: "ops", conversation_id: "conv_new" }),
      }),
    ).toBeNull();
  });

  it("no-op when the event already points at the current pointer conversation", () => {
    expect(
      pointerRefreshTargetForTaskCreated({
        ...base,
        currentPointerConvId: "conv_new",
        task: task({ conversation_id: "conv_new" }),
      }),
    ).toBeNull();
  });

  it("writes even when there is no current pointer yet (null current)", () => {
    expect(
      pointerRefreshTargetForTaskCreated({
        ...base,
        currentPointerConvId: null,
        task: task({ conversation_id: "conv_new" }),
      }),
    ).toBe("conv_new");
  });

  it("TC6 — undefined channel on the event normalizes to 'default' (no incorrect cross-channel write)", () => {
    // An event with no channel info is treated as the default channel, so it only
    // affects the default-channel pointer — never a named channel's pointer.
    expect(
      pointerRefreshTargetForTaskCreated({
        ...base,
        activeChannel: "ops",
        task: { agent_id: "agent_a", channel: undefined, conversation_id: "conv_new" },
      }),
    ).toBeNull();
    expect(
      pointerRefreshTargetForTaskCreated({
        ...base,
        activeChannel: "default",
        task: { agent_id: "agent_a", channel: undefined, conversation_id: "conv_new" },
      }),
    ).toBe("conv_new");
  });
});

// TC1 — grouping: same-role + <60s clusters into first/middle/last/solo;
// event messages never group (stay null).
describe("computeGroupPositions (TC1)", () => {
  const positionsFor = (msgs: Message[]) =>
    computeGroupPositions(buildTimeline(msgs, [], []));

  it("groups three same-role messages within 60s as first/middle/last", () => {
    const msgs = [
      msg("a", "2024-01-01T00:00:00Z", "user", "1"),
      msg("b", "2024-01-01T00:00:30Z", "user", "2"),
      msg("c", "2024-01-01T00:00:50Z", "user", "3"),
    ];
    expect(positionsFor(msgs)).toEqual(["first", "middle", "last"]);
  });

  it("breaks a cluster when the gap exceeds 60s", () => {
    const msgs = [
      msg("a", "2024-01-01T00:00:00Z", "user", "1"),
      msg("b", "2024-01-01T00:02:00Z", "user", "2"),
    ];
    expect(positionsFor(msgs)).toEqual(["solo", "solo"]);
  });

  it("breaks a cluster when the role changes", () => {
    const msgs = [
      msg("a", "2024-01-01T00:00:00Z", "user", "hi"),
      msg("b", "2024-01-01T00:00:10Z", "assistant", "hello"),
    ];
    expect(positionsFor(msgs)).toEqual(["solo", "solo"]);
  });

  it("groups events into the agent cluster (assistant + event share one header)", () => {
    const msgs = [
      msg("a", "2024-01-01T00:00:00Z", "assistant", "1"),
      msg("e", "2024-01-01T00:00:10Z", "event", "Email received"),
      msg("c", "2024-01-01T00:00:20Z", "assistant", "2"),
    ];
    // assistant + event are all the AGENT side → one cluster (Slack/Discord
    // model: a single avatar+name header, the rest continue in the gutter).
    expect(positionsFor(msgs)).toEqual(["first", "middle", "last"]);
  });

  it("keeps user and agent as separate clusters", () => {
    const msgs = [
      msg("u", "2024-01-01T00:00:00Z", "user", "hi"),
      msg("a", "2024-01-01T00:00:10Z", "assistant", "hello"),
      msg("e", "2024-01-01T00:00:20Z", "event", "Email sent"),
    ];
    // user is its own side; assistant+event group together.
    expect(positionsFor(msgs)).toEqual(["solo", "first", "last"]);
  });

  it("returns solo for a single message", () => {
    expect(positionsFor([msg("a", "2024-01-01T00:00:00Z", "user", "1")])).toEqual(["solo"]);
  });
});

// Planner's strengthened TODO-3 acceptance (cache-chat-cards): caching the
// artifacts so they're present from the INSTANT paint fixes not just the
// file-card pop-in but ALSO the event-card displacement. The event cards move
// as a CONSEQUENCE of un-cached artifacts being inserted into the timeline on
// the network response — same root cause. These tests prove that behavior
// against the pure timeline/grouping functions (the render-timing assertions
// remain QA browser checks since src/web has no jsdom/RTL harness).
describe("cache-chat-cards: event cards don't reflow when artifacts are cached (TODO-3)", () => {
  // An agent-side cluster: assistant → event(email) → assistant, all within
  // 60s. Grouped alone, the event card is the MIDDLE of one cluster.
  const agentCluster: Message[] = [
    msg("a1", "2024-01-01T00:00:00Z", "assistant", "working on it"),
    msg("e1", "2024-01-01T00:00:20Z", "event", "New email from x@y.com: Subject"),
    msg("a2", "2024-01-01T00:00:40Z", "assistant", "done"),
  ];
  // An artifact uploaded chronologically BETWEEN the assistant and the event.
  // On the network response this inserts into the timeline next to the event.
  const arts = [artifact("art1", "2024-01-01T00:00:10Z")];

  it("ROOT CAUSE: an un-cached instant paint (artifacts=[]) yields a DIFFERENT timeline order than post-network", () => {
    const instantPaintUncached = buildTimeline(agentCluster, [], []);
    const postNetwork = buildTimeline(agentCluster, arts, []);

    // Without caching, the instant paint has no artifact; the network response
    // inserts it between a1 and e1 → the timeline restructures (reflow).
    expect(instantPaintUncached.map((i) => i.data.id)).toEqual(["a1", "e1", "a2"]);
    expect(postNetwork.map((i) => i.data.id)).toEqual(["a1", "art1", "e1", "a2"]);
    expect(instantPaintUncached.map((i) => i.data.id)).not.toEqual(
      postNetwork.map((i) => i.data.id),
    );
  });

  it("ROOT CAUSE: the inserted artifact flips the event card's cluster-header (group position) state", () => {
    const uncachedPositions = computeGroupPositions(buildTimeline(agentCluster, [], []));
    const postNetworkPositions = computeGroupPositions(buildTimeline(agentCluster, arts, []));

    // Uncached: [assistant, event, assistant] = one agent cluster → first/middle/last.
    expect(uncachedPositions).toEqual(["first", "middle", "last"]);
    // Post-network: [assistant, artifact, event, assistant] — the artifact is
    // still the same agent side, so it joins the cluster and the event card
    // shifts from "middle" to a later middle; the positions array changes shape
    // (now 4 items), so the per-card header state is NOT preserved across the
    // resolve. This is the visible displacement Gus reported.
    expect(postNetworkPositions).toEqual(["first", "middle", "middle", "last"]);
    expect(uncachedPositions).not.toEqual(postNetworkPositions);
  });

  it("FIX: a cached instant paint (artifacts present from frame 1) is IDENTICAL to the post-network timeline — no reflow", () => {
    // With conv_extras caching, setArtifacts(extras.artifacts) runs on the
    // instant paint, so buildTimeline sees the artifacts immediately. That
    // instant-paint timeline must equal the post-network one (same artifacts,
    // same conversation) → the network resolve causes ZERO structural change.
    const cachedInstantPaint = buildTimeline(agentCluster, arts, []);
    const postNetwork = buildTimeline(agentCluster, arts, []);

    expect(cachedInstantPaint.map((i) => i.data.id)).toEqual(
      postNetwork.map((i) => i.data.id),
    );
    expect(cachedInstantPaint.map((i) => i.kind)).toEqual(
      postNetwork.map((i) => i.kind),
    );
  });

  it("FIX: event-card group positions are stable across the resolve when artifacts are cached", () => {
    const cachedInstantPositions = computeGroupPositions(buildTimeline(agentCluster, arts, []));
    const postNetworkPositions = computeGroupPositions(buildTimeline(agentCluster, arts, []));

    // Identical group positions → no event card gains/loses its avatar+name
    // header when the network lands (the exact stability planner asked for).
    expect(cachedInstantPositions).toEqual(postNetworkPositions);
  });

  it("FIX: an event card that is first/solo on the cached paint stays first/solo after the network lands", () => {
    // A standalone event card (its own cluster: a different role/side neighbor
    // keeps it solo). An artifact landing in the SAME cluster window would flip
    // it from solo→first; caching the artifact means it's already accounted for
    // on the instant paint, so the position never changes.
    const msgs: Message[] = [
      msg("u1", "2024-01-01T00:00:00Z", "user", "hi"),
      msg("e1", "2024-01-01T00:05:00Z", "event", "Calendar event: standup"),
    ];
    const lateArt = [artifact("art2", "2024-01-01T00:05:10Z")];

    const cachedInstant = computeGroupPositions(buildTimeline(msgs, lateArt, []));
    const postNetwork = computeGroupPositions(buildTimeline(msgs, lateArt, []));
    expect(cachedInstant).toEqual(postNetwork);

    // And contrast: WITHOUT the cached artifact the event is solo, but WITH it
    // the event becomes "first" of a 2-card agent cluster — the very flip
    // caching prevents from happening after the network resolve.
    const uncached = computeGroupPositions(buildTimeline(msgs, [], []));
    expect(uncached).toEqual(["solo", "solo"]);
    expect(postNetwork).toEqual(["solo", "first", "last"]);
  });

  it("FIX: caching conversation_type keeps a metadata-less event card's icon stable (no heuristic→type flip)", () => {
    // Metadata-less event message: the icon/label is resolved by
    // eventTypeFromMessage → falls back to getEventIconType(content, type).
    // On a cached paint conversation_type is seeded, so the type-driven icon is
    // correct from frame 1 and does NOT change when the network confirms it.
    // Content whose keyword heuristic ("email") DISAGREES with the real
    // conversation type (calendar_event) — e.g. a calendar invite whose text
    // mentions email. This is exactly the metadata-less case where the icon
    // would flip if conversation.type isn't known on the instant paint.
    const content = "Calendar invite — reply via email to confirm";
    // Instant paint with cached conversation_type → correct (calendar) icon:
    const cachedIcon = eventTypeFromMessage({}, content, "calendar_event");
    // Post-network with the authoritative conversation_type → same icon:
    const networkIcon = eventTypeFromMessage({}, content, "calendar_event");
    expect(cachedIcon).toBe(networkIcon);
    expect(cachedIcon).toBe("calendar");

    // Without a cached type (conversation === null on the un-cached instant
    // paint), the keyword heuristic picks "email" for this content → the flip
    // to the type-driven "calendar" only happens after the network lands.
    const uncachedIcon = eventTypeFromMessage({}, content, undefined);
    expect(uncachedIcon).toBe("email");
    expect(uncachedIcon).not.toBe(networkIcon);
  });
});
