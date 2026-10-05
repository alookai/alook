"use client";
import { useObservedRegion } from "@/lib/observability/regions";
import { mergeEvidence, sourceEvidence, valueEvidence } from "@/lib/observability/data-source";

import { useSelector } from "@tanstack/react-store";
import { useQuery, useMutation } from "@tanstack/react-query";
import { applicationKey, useApplicationOwner } from "@/lib/application-owner";
import { useApplicationViewSource } from "@/hooks/use-application-view-source";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { isNotificationSupported, setNotificationEnabled, setNotificationEvents, requestNotificationPermission, NOTIFICATION_EVENTS, NOTIFICATION_EVENT_LABELS, type NotificationEvent } from "@/lib/browser-notification";

export function NotificationTab() {
  const owner = useApplicationOwner();
  const source = useApplicationViewSource("workspace-notifications");
  const preferences = useSelector(owner.preferences, (state) => state.browserNotifications);
  const notifEnabled = preferences.enabled;
  const notifEvents = preferences.events;
  const permission = useQuery({
    queryKey: applicationKey(owner, "browser-notification-permission"),
    queryFn: () => ({ supported: isNotificationSupported(), denied: isNotificationSupported() && Notification.permission === "denied" }),
    staleTime: 0,
  });
  const notifSupported = permission.data?.supported ?? true;
  const notifDenied = permission.data?.denied ?? false;
  useObservedRegion("settings", !permission.isPending, { ...mergeEvidence([sourceEvidence(preferences, "unknown"), valueEvidence(owner.queryClient, permission.data)]), count: 1 });
  const command = useMutation({ meta: { observabilityAction: "notification.permission.request" }, mutationKey: applicationKey(owner, "browser-notification-permission", "request"),
    mutationFn: async (original: ReturnType<typeof source.capture>) => {
      original.assert();
      const granted = await requestNotificationPermission();
      original.assert();
      owner.queryClient.setQueryData(applicationKey(owner, "browser-notification-permission"), { supported: isNotificationSupported(), denied: !granted });
      if (granted) {
        setNotificationEnabled(true, owner.userId);
        owner.preferences.setState((state) => ({ ...state, browserNotifications: { ...state.browserNotifications, enabled: true } }));
      }
      return granted;
    },
  });

  const handleToggleNotification = async (checked: boolean) => {
    const original = source.capture();
    original.assert();
    if (!checked) {
      setNotificationEnabled(false, owner.userId);
      owner.preferences.setState((state) => ({ ...state, browserNotifications: { ...state.browserNotifications, enabled: false } }));
      return;
    }
    try {
      const granted = await command.mutateAsync(original);
      original.assert();
      if (!granted) toast.error("Notification permission denied. Please enable it in browser settings.");
    } catch (error) {
      try { original.assert(); } catch { return; }
      if (!(error instanceof DOMException && error.name === "AbortError")) toast.error(error instanceof Error ? error.message : "Failed to enable notifications");
    }
  };

  const handleToggleEvent = (event: NotificationEvent) => {
    source.capture().assert();
    const current = owner.preferences.get().browserNotifications;
    const events = current.events.includes(event) ? current.events.filter((value) => value !== event) : [...current.events, event];
    setNotificationEvents(events, owner.userId);
    owner.preferences.setState((state) => ({ ...state, browserNotifications: { ...state.browserNotifications, events } }));
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
              disabled={command.isPending || (notifDenied && !notifEnabled)}
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
