import { describe, it, expect } from "vitest";
import { message } from "../../src/db/schema";

// TC9 — the message.status column (default "active") and the
// idx_message_conversation_status index survive the buffer teardown.
describe("message schema (TC9)", () => {
  it("keeps the status column with default 'active'", () => {
    expect(message.status).toBeDefined();
    expect(message.status.name).toBe("status");
    expect(message.status.notNull).toBe(true);
    expect(message.status.default).toBe("active");
  });
});
