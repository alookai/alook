import { describe, expect, it } from "vitest";
import {
  canDiscardEmail,
  canSendDraftEmail,
  getMailboxAddressFields,
  isInboundDraftReviewEmail,
  isOutboundDraftEmail,
} from "../../src/lib/email-mailbox";

describe("email mailbox policy", () => {
  it("distinguishes inbound review drafts from outbound compose drafts", () => {
    expect(isInboundDraftReviewEmail({ mailbox: "draft", direction: "inbound" })).toBe(true);
    expect(isInboundDraftReviewEmail({ mailbox: "draft", direction: "outbound" })).toBe(false);
    expect(isOutboundDraftEmail({ mailbox: "draft", direction: "outbound" })).toBe(true);
    expect(isOutboundDraftEmail({ mailbox: "draft", direction: "inbound" })).toBe(false);
  });

  it("centralizes allowed actions for draft mailbox records", () => {
    expect(canDiscardEmail({ mailbox: "draft", direction: "inbound" })).toBe(true);
    expect(canDiscardEmail({ mailbox: "draft", direction: "outbound" })).toBe(false);
    expect(canSendDraftEmail({ mailbox: "draft", direction: "outbound", status: "draft" })).toBe(true);
    expect(canSendDraftEmail({ mailbox: "draft", direction: "outbound", status: "send_unknown" })).toBe(false);
    expect(canSendDraftEmail({ mailbox: "draft", direction: "outbound", status: "sending" })).toBe(false);
    expect(canSendDraftEmail({ mailbox: "sent", direction: "outbound" })).toBe(false);
  });

  it("centralizes which address fields define folder membership", () => {
    expect(getMailboxAddressFields("inbox")).toEqual(["toEmail"]);
    expect(getMailboxAddressFields("untrust")).toEqual(["toEmail"]);
    expect(getMailboxAddressFields("sent")).toEqual(["fromEmail"]);
    expect(getMailboxAddressFields("draft")).toEqual(["toEmail", "fromEmail"]);
  });
});
