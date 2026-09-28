import { describe, it, expect, beforeEach } from "vitest";
import type { Message } from "@alook/shared";
import {
  openAgentChatPersistence,
  getCachedMessages,
  mergeCachedMessages,
  resetAgentChatPersistenceForTests,
} from "@/lib/agent-chat-persistence";

const SCOPE = { accountId: "account_test", workspaceId: "ws_test" };

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    conversation_id: "conv_1",
    role: "user",
    content: "hello",
    task_id: null,
    attachment_ids: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  await resetAgentChatPersistenceForTests();
  await openAgentChatPersistence(SCOPE);
});

describe("use-cached-messages (functional tests)", () => {
  it("getCachedMessages returns cached messages immediately after write", async () => {
    const msgs = [
      makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
      makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
    ];
    await mergeCachedMessages("conv_1", msgs, false, SCOPE);

    const cached = await getCachedMessages("conv_1", SCOPE);
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(2);
    expect(cached![0].id).toBe("m1");
    expect(cached![1].id).toBe("m2");
  });

  it("returns null when no cache exists", async () => {
    const cached = await getCachedMessages("conv_nonexistent", SCOPE);
    expect(cached).toBeNull();
  });

  it("writeToCache (mergeCachedMessages) persists messages correctly", async () => {
    const msgs = [
      makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
    ];
    await mergeCachedMessages("conv_1", msgs, false, SCOPE);

    const cached = await getCachedMessages("conv_1", SCOPE);
    expect(cached).toHaveLength(1);
    expect(cached![0].id).toBe("m1");
  });

  it("conversation switch loads correct cache", async () => {
    await mergeCachedMessages(
      "conv_1",
      [makeMessage({ id: "m1", conversation_id: "conv_1" })],
      false,
      SCOPE
    );
    await mergeCachedMessages(
      "conv_2",
      [makeMessage({ id: "m2", conversation_id: "conv_2" })],
      false,
      SCOPE
    );

    const cached1 = await getCachedMessages("conv_1", SCOPE);
    const cached2 = await getCachedMessages("conv_2", SCOPE);

    expect(cached1).toHaveLength(1);
    expect(cached1![0].id).toBe("m1");
    expect(cached2).toHaveLength(1);
    expect(cached2![0].id).toBe("m2");
  });
});
