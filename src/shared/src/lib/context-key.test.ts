import { describe, it, expect } from "vitest";
import { extractThreadId, buildContextKey } from "./context-key";
import { TASK_TYPES } from "../constants";

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

describe("buildContextKey", () => {
  it("returns dm:{conversationId} for USER_DM_MESSAGE with conversationId", () => {
    expect(
      buildContextKey(TASK_TYPES.USER_DM_MESSAGE, { conversationId: "conv_123" }),
    ).toBe("dm:conv_123");
  });

  it("returns null for USER_DM_MESSAGE without conversationId", () => {
    expect(buildContextKey(TASK_TYPES.USER_DM_MESSAGE, {})).toBeNull();
  });

  it("returns email:{threadId} for EMAIL_NOTIFICATION with threadId", () => {
    expect(
      buildContextKey(TASK_TYPES.EMAIL_NOTIFICATION, { threadId: "<abc@mail.com>" }),
    ).toBe("email:<abc@mail.com>");
  });

  it("returns null for EMAIL_NOTIFICATION without threadId", () => {
    expect(buildContextKey(TASK_TYPES.EMAIL_NOTIFICATION, {})).toBeNull();
  });

  it("returns null for EMAIL_NOTIFICATION with null threadId", () => {
    expect(buildContextKey(TASK_TYPES.EMAIL_NOTIFICATION, { threadId: null })).toBeNull();
  });

  it("returns null for CALENDAR_EVENT", () => {
    expect(buildContextKey(TASK_TYPES.CALENDAR_EVENT, {})).toBeNull();
  });

  it("returns null for CALENDAR_EVENT even with conversationId", () => {
    expect(
      buildContextKey(TASK_TYPES.CALENDAR_EVENT, { conversationId: "conv_123" }),
    ).toBeNull();
  });

  it("returns null for unknown type", () => {
    expect(buildContextKey("unknown_type", { conversationId: "conv_123" })).toBeNull();
  });
});
