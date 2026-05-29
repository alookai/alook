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

describe("email query module exports", () => {
  it("exports getInboxEmails", () => {
    expect(typeof emailQueries.getInboxEmails).toBe("function");
  });

  it("exports getSentEmails", () => {
    expect(typeof emailQueries.getSentEmails).toBe("function");
  });

  it("exports getRejectedEmails", () => {
    expect(typeof emailQueries.getRejectedEmails).toBe("function");
  });

  it("exports getEmailByMessageId", () => {
    expect(typeof emailQueries.getEmailByMessageId).toBe("function");
  });

  it("exports deleteEmail", () => {
    expect(typeof emailQueries.deleteEmail).toBe("function");
  });

  it("exports createEmail", () => {
    expect(typeof emailQueries.createEmail).toBe("function");
  });

  it("exports getEmailById", () => {
    expect(typeof emailQueries.getEmailById).toBe("function");
  });

  it("exports getEmailsByAgent", () => {
    expect(typeof emailQueries.getEmailsByAgent).toBe("function");
  });

  it("exports updateEmailStatus", () => {
    expect(typeof emailQueries.updateEmailStatus).toBe("function");
  });
});

describe("email query function signatures", () => {
  it("getEmailsByAgent accepts optional status and pagination parameters", () => {
    // (db, agentId, workspaceId, status?, pagination?)
    expect(emailQueries.getEmailsByAgent.length).toBeLessThanOrEqual(5);
  });

  it("getInboxEmails accepts optional status and pagination parameters", () => {
    expect(emailQueries.getInboxEmails.length).toBeLessThanOrEqual(6);
  });

  it("getSentEmails accepts optional status and pagination parameters", () => {
    expect(emailQueries.getSentEmails.length).toBeLessThanOrEqual(6);
  });

  it("getRejectedEmails requires agentEmail parameter to exclude outbound", () => {
    // (db, agentId, agentEmail, workspaceId, status?)
    expect(emailQueries.getRejectedEmails.length).toBeGreaterThanOrEqual(4);
  });

  it("updateEmailStatus has correct arity", () => {
    // (db, id, workspaceId, status)
    expect(emailQueries.updateEmailStatus.length).toBe(4);
  });
});

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
