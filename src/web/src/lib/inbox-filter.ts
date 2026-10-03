import type { ApplicationOwner } from "./application-owner";
const storageKey = (userId: string) => `alook:${userId}:inbox-filter-types`;

export const INBOX_FILTER_TYPES = [
  "user_dm_message",
  "calendar_event",
  "email_notification",
] as const;

export type InboxFilterType = (typeof INBOX_FILTER_TYPES)[number];

export const INBOX_FILTER_LABELS: Record<InboxFilterType, string> = {
  user_dm_message: "DM",
  calendar_event: "Calendar",
  email_notification: "Email",
};

export const DEFAULT_INBOX_TYPES: InboxFilterType[] = ["user_dm_message"];

export const MANDATORY_INBOX_TYPES: InboxFilterType[] = ["user_dm_message"];

export function readStoredInboxFilterTypes(userId: string): InboxFilterType[] {
  if (typeof window === "undefined") return DEFAULT_INBOX_TYPES;
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return DEFAULT_INBOX_TYPES;
    const parsed = JSON.parse(raw) as string[];
    const valid = parsed.filter((t): t is InboxFilterType =>
      INBOX_FILTER_TYPES.includes(t as InboxFilterType),
    );
    if (valid.length === 0) return DEFAULT_INBOX_TYPES;
    for (const m of MANDATORY_INBOX_TYPES) {
      if (!valid.includes(m)) valid.unshift(m);
    }
    return valid;
  } catch {
    return DEFAULT_INBOX_TYPES;
  }
}

export function getInboxFilterTypes(owner: ApplicationOwner): InboxFilterType[] {
  return owner.preferences.get().inboxFilterTypes;
}

export function setInboxFilterTypes(owner: ApplicationOwner, types: InboxFilterType[]): void {
  if (!owner.lifecycle.get().active) return;
  const withMandatory = [...types];
  for (const m of MANDATORY_INBOX_TYPES) {
    if (!withMandatory.includes(m)) withMandatory.unshift(m);
  }
  owner.preferences.setState((state) => ({ ...state, inboxFilterTypes: withMandatory }));
  try { localStorage.setItem(storageKey(owner.userId), JSON.stringify(withMandatory)); } catch {}
}
