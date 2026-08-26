import { describe, expect, it } from "vitest";
import {
  isUserWsConnectionPing,
  isUserWsConnectionPong,
  USER_WS_CONNECTION_VALIDATION_NONCE_MAX_LENGTH,
} from "./user-ws-validation";

describe("user WebSocket connection validation", () => {
  it("accepts exact bounded ping and pong frames", () => {
    const nonce = `resume_${"a".repeat(USER_WS_CONNECTION_VALIDATION_NONCE_MAX_LENGTH - 7)}`;

    expect(isUserWsConnectionPing({ type: "connection.ping", nonce })).toBe(true);
    expect(isUserWsConnectionPong({ type: "connection.pong", nonce })).toBe(true);
  });

  it.each([
    null,
    [],
    { type: "connection.ping" },
    { type: "connection.ping", nonce: "" },
    { type: "connection.ping", nonce: "contains spaces" },
    { type: "connection.ping", nonce: "a".repeat(USER_WS_CONNECTION_VALIDATION_NONCE_MAX_LENGTH + 1) },
    { type: "connection.ping", nonce: "valid", extra: true },
    { type: "connection.pong", nonce: 42 },
  ])("rejects malformed or non-exact frames %#", (frame) => {
    expect(isUserWsConnectionPing(frame)).toBe(false);
    expect(isUserWsConnectionPong(frame)).toBe(false);
  });
});
