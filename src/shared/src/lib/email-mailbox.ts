import { EmailMailbox } from "../constants";
import type { EmailMailboxType } from "../constants";
import type { EmailDirection } from "../types";

type MailboxPolicyEmail = {
  mailbox: string;
  direction: EmailDirection | string;
  status?: string;
};

// TODO: the concept of draft is overused here, we should have a seperated concept for draft emails and review emails.

export function isInboundDraftReviewEmail(email: MailboxPolicyEmail): boolean {
  return email.mailbox === EmailMailbox.DRAFT && email.direction === "inbound";
}

export function isOutboundDraftEmail(email: MailboxPolicyEmail): boolean {
  return email.mailbox === EmailMailbox.DRAFT && email.direction === "outbound";
}

export function canDiscardEmail(email: MailboxPolicyEmail): boolean {
  return isInboundDraftReviewEmail(email);
}

export function canSendDraftEmail(email: MailboxPolicyEmail): boolean {
  return isOutboundDraftEmail(email) && email.status === "draft";
}

export function getMailboxAddressFields(mailbox: EmailMailboxType): readonly ["toEmail"] | readonly ["fromEmail"] | readonly ["toEmail", "fromEmail"] {
  if (mailbox === EmailMailbox.SENT) return ["fromEmail"];
  if (mailbox === EmailMailbox.DRAFT) return ["toEmail", "fromEmail"];
  return ["toEmail"];
}
