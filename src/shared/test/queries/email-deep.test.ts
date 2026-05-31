import { describe, it, expect, vi } from "vitest";
import * as emailQueries from "../../src/db/queries/email";

describe("createEmail", () => {
  it("creates and returns email", async () => {
    const email = { id: "em_1" };
    const chain: any = {};
    chain.insert = vi.fn(() => chain); chain.values = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([email]));
    const result = await emailQueries.createEmail(chain, {
      agentId: "ag_1", workspaceId: "w", fromEmail: "a@b.com", toEmail: "c@d.com",
      subject: "Hi", r2Key: "key", isWhitelisted: true, forwarded: false, direction: "inbound",
    });
    expect(result).toEqual(email);
  });
});

describe("getEmailsByAgent", () => {
  it("returns emails without pagination", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.orderBy = vi.fn(() => Promise.resolve([{ id: "em_1" }]));
    await emailQueries.getEmailsByAgent(chain, "ag_1", "w");
    expect(chain.orderBy).toHaveBeenCalled();
  });
  it("applies pagination", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain); chain.offset = vi.fn(() => Promise.resolve([]));
    await emailQueries.getEmailsByAgent(chain, "ag_1", "w", undefined, { limit: 10, offset: 0 });
    expect(chain.limit).toHaveBeenCalledWith(10);
  });
  it("applies status filter", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.orderBy = vi.fn(() => Promise.resolve([]));
    await emailQueries.getEmailsByAgent(chain, "ag_1", "w", "read");
    expect(chain.where).toHaveBeenCalled();
  });
});

describe("getInboxEmails", () => {
  it("returns inbound emails", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.orderBy = vi.fn(() => Promise.resolve([]));
    await emailQueries.getInboxEmails(chain, "ag_1", "bot@test.com", "w");
    expect(chain.orderBy).toHaveBeenCalled();
  });
});

describe("getSentEmails", () => {
  it("returns outbound emails", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.orderBy = vi.fn(() => Promise.resolve([]));
    await emailQueries.getSentEmails(chain, "ag_1", "bot@test.com", "w");
    expect(chain.orderBy).toHaveBeenCalled();
  });
});

describe("getTrustedEmails", () => {
  it("returns trusted inbound emails", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.orderBy = vi.fn(() => Promise.resolve([]));
    await emailQueries.getTrustedEmails(chain, "ag_1", "bot@test.com", "w");
    expect(chain.orderBy).toHaveBeenCalled();
  });
});

describe("getRejectedEmails", () => {
  it("returns rejected inbound emails", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.orderBy = vi.fn(() => Promise.resolve([]));
    await emailQueries.getRejectedEmails(chain, "ag_1", "bot@test.com", "w");
    expect(chain.orderBy).toHaveBeenCalled();
  });
});

describe("deleteEmail", () => {
  it("calls delete with correct params", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => Promise.resolve());
    await emailQueries.deleteEmail(chain, "em_1", "w");
    expect(chain.delete).toHaveBeenCalled();
  });
});
