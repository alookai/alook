"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  isNotificationSupported,
  getNotificationEnabled,
  setNotificationEnabled,
  getNotificationEvents,
  setNotificationEvents,
  requestNotificationPermission,
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_LABELS,
  type NotificationEvent,
} from "@/lib/browser-notification";

export function NotificationTab() {
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [notifEvents, setNotifEvents] = useState<NotificationEvent[]>([...NOTIFICATION_EVENTS]);
  const [notifSupported, setNotifSupported] = useState(true);
  const [notifDenied, setNotifDenied] = useState(false);

  useEffect(() => {
    setNotifSupported(isNotificationSupported());
    setNotifEnabled(getNotificationEnabled());
    setNotifEvents(getNotificationEvents());
    if (isNotificationSupported()) {
      setNotifDenied(Notification.permission === "denied");
    }
  }, []);

  const handleToggleNotification = async (checked: boolean) => {
    if (!checked) {
      setNotifEnabled(false);
      setNotificationEnabled(false);
      return;
    }
    const granted = await requestNotificationPermission();
    if (granted) {
      setNotifEnabled(true);
      setNotificationEnabled(true);
    } else {
      setNotifDenied(true);
      toast.error("Notification permission denied. Please enable it in browser settings.");
    }
  };

  const handleToggleEvent = (event: NotificationEvent) => {
    setNotifEvents((prev) => {
      const next = prev.includes(event)
        ? prev.filter((e) => e !== event)
        : [...prev, event];
      setNotificationEvents(next);
      return next;
    });
  };

  if (!notifSupported) {
    return (
      <p className="text-sm text-muted-foreground">
        Your browser does not support notifications.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <h2 className="text-sm font-medium">Browser Notifications</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="text-sm">Enable notifications</p>
              <p className="text-xs text-muted-foreground">
                Get notified when tasks finish while the tab is in the background
              </p>
            </div>
            <Switch
              checked={notifEnabled}
              onCheckedChange={handleToggleNotification}
              disabled={notifDenied && !notifEnabled}
            />
          </div>
          {notifDenied && !notifEnabled && (
            <p className="text-xs text-destructive">
              Notification permission was denied. Please allow it in your browser settings.
            </p>
          )}
          {notifEnabled && (
            <div className="space-y-2 pl-0.5">
              <p className="text-xs text-muted-foreground">Notify me when:</p>
              {NOTIFICATION_EVENTS.map((event) => (
                <label key={event} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <Checkbox
                    checked={notifEvents.includes(event)}
                    onCheckedChange={() => handleToggleEvent(event)}
                  />
                  {NOTIFICATION_EVENT_LABELS[event]}
                </label>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
