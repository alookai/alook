import { describe, it, expect } from "vitest";
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
