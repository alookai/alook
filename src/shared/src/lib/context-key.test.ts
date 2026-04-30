import { describe, it, expect } from "vitest";
import { extractThreadId, buildEmailMapKey } from "./context-key";

describe("extractThreadId", () => {
  it("returns first message-id from references when available", () => {
    expect(
      extractThreadId("<abc@mail.com> <def@mail.com>", "<ghi@mail.com>", "<jkl@mail.com>"),
    ).toBe("<abc@mail.com>");
  });

  it("falls back to inReplyTo when references is empty", () => {
    expect(extractThreadId("", "<reply@mail.com>", "<msg@mail.com>")).toBe("<reply@mail.com>");
  });

  it("falls back to inReplyTo when references is undefined", () => {
    expect(extractThreadId(undefined, "<reply@mail.com>", "<msg@mail.com>")).toBe(
      "<reply@mail.com>",
    );
  });

  it("falls back to messageId when references and inReplyTo are empty", () => {
    expect(extractThreadId("", "", "<msg@mail.com>")).toBe("<msg@mail.com>");
  });

  it("falls back to messageId when references and inReplyTo are undefined", () => {
    expect(extractThreadId(undefined, undefined, "<msg@mail.com>")).toBe("<msg@mail.com>");
  });

  it("returns null when all inputs are empty strings", () => {
    expect(extractThreadId("", "", "")).toBeNull();
  });

  it("returns null when all inputs are undefined", () => {
    expect(extractThreadId(undefined, undefined, undefined)).toBeNull();
  });

  it("returns null when no arguments provided", () => {
    expect(extractThreadId()).toBeNull();
  });

  it("trims whitespace from inReplyTo", () => {
    expect(extractThreadId(undefined, "  <trimmed@mail.com>  ")).toBe("<trimmed@mail.com>");
  });

  it("trims whitespace from messageId", () => {
    expect(extractThreadId(undefined, undefined, "  <trimmed@mail.com>  ")).toBe(
      "<trimmed@mail.com>",
    );
  });
});

describe("buildEmailMapKey", () => {
  it("returns email:<agentId>:<threadId>", () => {
    expect(buildEmailMapKey("agent123", "<msg-001@example.com>")).toBe(
      "email:agent123:<msg-001@example.com>",
    );
  });

  it("handles different agent and thread IDs", () => {
    expect(buildEmailMapKey("ag_abc", "<thread@mail.com>")).toBe(
      "email:ag_abc:<thread@mail.com>",
    );
  });
});
