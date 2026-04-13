import { describe, it, expect } from "vitest";
import * as emailQueries from "../../src/db/queries/email";

describe("email query module exports", () => {
  it("exports getInboxEmails", () => {
    expect(typeof emailQueries.getInboxEmails).toBe("function");
  });

  it("exports getSentEmails", () => {
    expect(typeof emailQueries.getSentEmails).toBe("function");
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
});
