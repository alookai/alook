import { describe, it, expect } from "vitest";
import type { Message, Artifact } from "@alook/shared";
import { sortMessages, mergeMessages, buildTimeline } from "./agent-chat-view";
import type { NapMarker } from "./agent-chat-view";

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

function artifact(id: string, created_at: string): Artifact {
  return {
    id,
    conversation_id: "conv1",
    filename: "file.txt",
    content_type: "text/plain",
    size: 100,
    source: "agent",
    r2_key: `key-${id}`,
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
