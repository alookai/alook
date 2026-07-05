import { describe, it, expect } from "vitest";
import { HermesBackend } from "../hermes.js";

const backend = new HermesBackend("hermes");

describe("HermesBackend.parseLine", () => {
  it("empty line returns empty", () => {
    expect(backend.parseLine("")).toEqual([]);
  });

  it("whitespace-only line returns empty", () => {
    expect(backend.parseLine("   ")).toEqual([]);
  });

  it("session_id line → session_init", () => {
    const events = backend.parseLine("session_id: 20260705_140413_1a7e0b");
    expect(events).toEqual([
      { kind: "session_init", sessionId: "20260705_140413_1a7e0b" },
    ]);
  });

  it("session_id line with extra whitespace", () => {
    const events = backend.parseLine(
      "session_id:  20260705_140413_1a7e0b  ",
    );
    expect(events).toEqual([
      { kind: "session_init", sessionId: "20260705_140413_1a7e0b" },
    ]);
  });

  it("plain text line → text event", () => {
    const events = backend.parseLine("Hello, world!");
    expect(events).toEqual([{ kind: "text", text: "Hello, world!" }]);
  });

  it("multi-word text → single text event", () => {
    const events = backend.parseLine(
      "Here is a complete response from the agent.",
    );
    expect(events).toEqual([
      { kind: "text", text: "Here is a complete response from the agent." },
    ]);
  });

  it("code block line → text event", () => {
    const events = backend.parseLine("```typescript");
    expect(events).toEqual([{ kind: "text", text: "```typescript" }]);
  });
});

describe("HermesBackend.encodeStdinMessage", () => {
  it("always returns null", () => {
    expect(backend.encodeStdinMessage("hi", "idle")).toBeNull();
    expect(backend.encodeStdinMessage("hi", "busy")).toBeNull();
  });
});

describe("HermesBackend properties", () => {
  it("has correct name", () => {
    expect(backend.name).toBe("hermes");
  });

  it("has per_turn lifecycle", () => {
    expect(backend.lifecycle.kind).toBe("per_turn");
  });

  it("has no busy delivery mode", () => {
    expect(backend.busyDeliveryMode).toBe("none");
  });

  it("does not support stdin notification", () => {
    expect(backend.supportsStdinNotification).toBe(false);
  });
});
