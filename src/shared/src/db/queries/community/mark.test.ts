import { describe, expect, it, vi } from "vitest";
import type { Database } from "../../index";
import { markMessage } from "./mark";

function markDb(returning: unknown[]) {
  const returningMock = vi.fn().mockResolvedValue(returning);
  const onConflictDoNothing = vi.fn(() => ({ returning: returningMock }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return {
    db: { insert } as unknown as Database,
    insert,
    values,
    onConflictDoNothing,
    returningMock,
  };
}

describe("community message marks", () => {
  it("returns the inserted row and reports an idempotent conflict as null", async () => {
    const inserted = { id: "mark_1", userId: "u1", channelId: "c1", messageId: "m1" };
    const created = markDb([inserted]);
    await expect(markMessage(created.db, {
      userId: "u1",
      channelId: "c1",
      messageId: "m1",
    })).resolves.toEqual(inserted);
    expect(created.values).toHaveBeenCalledWith({
      userId: "u1",
      channelId: "c1",
      messageId: "m1",
    });
    expect(created.onConflictDoNothing).toHaveBeenCalledOnce();
    expect(created.returningMock).toHaveBeenCalledOnce();

    const duplicate = markDb([]);
    await expect(markMessage(duplicate.db, {
      userId: "u1",
      channelId: "c1",
      messageId: "m1",
    })).resolves.toBeNull();
  });
});
