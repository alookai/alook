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
