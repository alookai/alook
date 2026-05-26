import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as emailQueries from "../../src/db/queries/email";

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

  it("exports getEmailsByMailbox", () => {
    expect(typeof emailQueries.getEmailsByMailbox).toBe("function");
  });

  it("exports updateEmailMailbox", () => {
    expect(typeof emailQueries.updateEmailMailbox).toBe("function");
  });

  it("does not export unused updateEmailDraft API", () => {
    expect("updateEmailDraft" in emailQueries).toBe(false);
  });

  it("exports claimDraftForSend", () => {
    expect(typeof emailQueries.claimDraftForSend).toBe("function");
  });

  it("exports finalizeDraftSend", () => {
    expect(typeof emailQueries.finalizeDraftSend).toBe("function");
  });

  it("exports restoreDraftAfterSendFailure", () => {
    expect(typeof emailQueries.restoreDraftAfterSendFailure).toBe("function");
  });

  it("exports markDraftSendUnknown", () => {
    expect(typeof emailQueries.markDraftSendUnknown).toBe("function");
  });

  it("exports promoteInboundWithDraftReply", () => {
    expect(typeof emailQueries.promoteInboundWithDraftReply).toBe("function");
  });

  it("exports archiveInboundDraftAsUntrust", () => {
    expect(typeof emailQueries.archiveInboundDraftAsUntrust).toBe("function");
  });

  it("exports getInboundDraftEmailForAgent", () => {
    expect(typeof emailQueries.getInboundDraftEmailForAgent).toBe("function");
  });

  it("exports recoverStaleEmailTriageApplies", () => {
    expect(typeof emailQueries.recoverStaleEmailTriageApplies).toBe("function");
  });

  it("does not export weak updateEmailAfterSend helper", () => {
    expect("updateEmailAfterSend" in emailQueries).toBe(false);
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

describe("promoteInboundWithDraftReply", () => {
  it("does not create outbound draft when inbound draft claim does not match", async () => {
    let insertCalled = false;
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve([]),
          }),
        }),
      }),
      insert: () => {
        insertCalled = true;
        return {
          values: () => ({
            returning: () => Promise.resolve([{ id: "e-draft" }]),
          }),
        };
      },
    };

    const result = await emailQueries.promoteInboundWithDraftReply(db as never, {
      inboundEmailId: "e-inbound",
      agentId: "a1",
      workspaceId: "w1",
      draft: {
        fromEmail: "agent@alook.ai",
        toEmail: "sender@test.com",
        subject: "Re: Hello",
        htmlBody: "<p>Hello</p>",
        inReplyTo: "<msg@test.com>",
        references: "<msg@test.com>",
      },
    });

    expect(result).toEqual({ applied: false });
    expect(insertCalled).toBe(false);
  });

  it("returns explicit cleanupError when fallback promote and draft cleanup both fail", async () => {
    let updateCalls = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{
            id: "e-inbound",
            agentId: "a1",
            workspaceId: "w1",
            direction: "inbound",
            mailbox: "draft",
            status: "unread",
          }]),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([{ id: "e-draft" }]),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => {
              updateCalls += 1;
              if (updateCalls === 1) return Promise.resolve([{ id: "e-inbound" }]);
              if (updateCalls === 2) return Promise.reject(new Error("promote failed"));
              return Promise.resolve([{ id: "e-inbound" }]);
            },
          }),
        }),
      }),
      delete: () => ({
        where: () => Promise.reject(new Error("cleanup failed")),
      }),
    };

    const result = await emailQueries.promoteInboundWithDraftReply(db as never, {
      inboundEmailId: "e-inbound",
      agentId: "a1",
      workspaceId: "w1",
      draft: {
        fromEmail: "agent@alook.ai",
        toEmail: "sender@test.com",
        subject: "Re: Hello",
        htmlBody: "<p>Hello</p>",
        inReplyTo: "<msg@test.com>",
        references: "<msg@test.com>",
      },
    });

    expect(result).toEqual({ applied: false, cleanupError: "cleanup failed" });
  });

  it("restores claimed inbound draft when draft insert returns no row", async () => {
    let updateCalls = 0;
    const statuses: string[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{
            id: "e-inbound",
            agentId: "a1",
            workspaceId: "w1",
            direction: "inbound",
            mailbox: "draft",
            status: "unread",
          }]),
        }),
      }),
      update: () => ({
        set: (patch: { status?: string }) => {
          if (patch.status) statuses.push(patch.status);
          return {
            where: () => ({
              returning: () => {
                updateCalls += 1;
                return Promise.resolve([{ id: "e-inbound" }]);
              },
            }),
          };
        },
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    };

    const result = await emailQueries.promoteInboundWithDraftReply(db as never, {
      inboundEmailId: "e-inbound",
      agentId: "a1",
      workspaceId: "w1",
      draft: {
        fromEmail: "agent@alook.ai",
        toEmail: "sender@test.com",
        subject: "Re: Hello",
        htmlBody: "<p>Hello</p>",
        inReplyTo: "<msg@test.com>",
        references: "<msg@test.com>",
      },
    });

    expect(result).toEqual({ applied: false });
    expect(updateCalls).toBe(2);
    expect(statuses).toEqual(["triage_applying", "unread"]);
  });
});

describe("archiveInboundDraftAsUntrust", () => {
  it("is scoped to agent, workspace, inbound direction, and draft mailbox", () => {
    const src = readFileSync(join(__dirname, "../../src/db/queries/email.ts"), "utf8");

    expect(src).toContain("export async function archiveInboundDraftAsUntrust");
    expect(src).toContain("eq(emails.agentId, input.agentId)");
    expect(src).toContain("eq(emails.workspaceId, input.workspaceId)");
    expect(src).toContain("eq(emails.direction, \"inbound\")");
    expect(src).toContain("eq(emails.mailbox, EmailMailbox.DRAFT)");
  });
});

describe("recoverStaleEmailTriageApplies", () => {
  it("restores inbound triage_applying emails and deletes orphan outbound triage_applying drafts", () => {
    const src = readFileSync(join(__dirname, "../../src/db/queries/email.ts"), "utf8");

    expect(src).toContain("export async function recoverStaleEmailTriageApplies");
    expect(src).toContain("eq(emails.status, \"triage_applying\")");
    expect(src).toContain("eq(emails.direction, \"inbound\")");
    expect(src).toContain("eq(emails.direction, \"outbound\")");
    expect(src).toContain("set({ mailbox: EmailMailbox.DRAFT, status: \"unread\" })");
    expect(src).toContain(".delete(emails)");
  });
});
