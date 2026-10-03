const STORAGE_KEY = "browser-notification-enabled";
const EVENTS_KEY = "browser-notification-events";

export const NOTIFICATION_EVENTS = ["completed", "failed"] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  completed: "Task Completed",
  failed: "Task Failed",
};

export function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

const accountKey = (key: string, accountId?: string) => accountId ? `alook:${accountId}:${key}` : key;

export function getNotificationEnabled(accountId?: string): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(accountKey(STORAGE_KEY, accountId)) === "true"; } catch { return false; }
}

export function setNotificationEnabled(enabled: boolean, accountId?: string): void {
  localStorage.setItem(accountKey(STORAGE_KEY, accountId), String(enabled));
}

export function getNotificationEvents(accountId?: string): NotificationEvent[] {
  if (typeof window === "undefined") return [...NOTIFICATION_EVENTS];
  try {
    const raw = localStorage.getItem(accountKey(EVENTS_KEY, accountId));
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return [...new Set(parsed.filter((event): event is NotificationEvent => NOTIFICATION_EVENTS.includes(event)))];
    }
  } catch {}
  return [...NOTIFICATION_EVENTS];
}

export function setNotificationEvents(events: NotificationEvent[], accountId?: string): void {
  localStorage.setItem(accountKey(EVENTS_KEY, accountId), JSON.stringify(events));
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!isNotificationSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export function sendTaskNotification(
  status: string,
  agentName?: string,
  body?: string,
  preferences?: { enabled: boolean; events: readonly NotificationEvent[] },
): void {
  if (typeof window === "undefined") return;
  if (!isNotificationSupported()) return;
  if (Notification.permission !== "granted") return;
  if (!(preferences?.enabled ?? getNotificationEnabled())) return;

  const events = preferences?.events ?? getNotificationEvents();
  if (!events.includes(status as NotificationEvent)) return;

  const label = NOTIFICATION_EVENT_LABELS[status as NotificationEvent] ?? `Task ${status}`;
  const title = agentName ? `${agentName} — ${label}` : label;
  new Notification(title, {
    body: body ?? "",
    icon: "/alook.svg",
  });
}
