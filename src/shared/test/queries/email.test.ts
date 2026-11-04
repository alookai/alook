import { describe, it, expect, vi } from "vitest";
import * as emailQueries from "../../src/db/queries/email";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.offset = vi.fn(() => Promise.resolve(rows));
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  chain.update = vi.fn(() => chain);
  chain.set = vi.fn(() => chain);
  chain.delete = vi.fn(() => chain);
  return chain;
}



describe("getEmailById", () => {
  it("returns null when email not found", async () => {
    const mockDb = createMockDb([]);
    const result = await emailQueries.getEmailById(mockDb, "em_missing", "ws_1");
    expect(result).toBeNull();
  });

  it("returns email when found", async () => {
    const email = { id: "em_1", subject: "Hello" };
    const mockDb = createMockDb([email]);
    const result = await emailQueries.getEmailById(mockDb, "em_1", "ws_1");
    expect(result).toEqual(email);
  });
});

describe("getEmailByMessageId", () => {
  it("returns null for empty messageId without querying DB", async () => {
    const result = await emailQueries.getEmailByMessageId(null as any, "", "ws_1");
    expect(result).toBeNull();
  });

  it("returns null when no email matches", async () => {
    const mockDb = createMockDb([]);
    const result = await emailQueries.getEmailByMessageId(mockDb, "<msg@test.com>", "ws_1");
    expect(result).toBeNull();
  });

  it("returns email when messageId matches", async () => {
    const email = { id: "em_1", messageId: "<msg@test.com>" };
    const mockDb = createMockDb([email]);
    const result = await emailQueries.getEmailByMessageId(mockDb, "<msg@test.com>", "ws_1");
    expect(result).toEqual(email);
  });
});

describe("updateEmailStatus", () => {
  it("returns null when email not found for update", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    const result = await emailQueries.updateEmailStatus(chain, "em_missing", "ws_1", "read");
    expect(result).toBeNull();
  });
});
