# FCM Android delivery observability

This worker sends Android chat notifications with explicit FCM `high` priority and the constant analytics label `alook_chat_notification_v1`. A daily cron reads only privacy-thresholded aggregate rows for that label and emits structured logs. It does not collect registration tokens, user IDs, device IDs, message IDs, channel/server IDs, or raw FCM responses.

This document is an activation runbook, not evidence that production configuration or deployment has happened. Do not run any activation or deploy command without separate approval.

## Before deployment

1. Enable the Firebase Cloud Messaging Data API for project `190599692413` if it is not already enabled. The service name is `fcmdata.googleapis.com`. A separately authorized operator may use `gcloud services enable fcmdata.googleapis.com --project 190599692413`.
2. Verify the existing FCM service account has `fcmdata.deliverydata.list`. The predefined Firebase Cloud Messaging API Admin role (`roles/firebasecloudmessaging.admin`) includes this permission. Prefer verifying the existing role over adding or broadening IAM access.
3. Keep using the existing `FCM_CLIENT_EMAIL` and `FCM_PRIVATE_KEY` Worker secrets. Do not create or commit another service-account key. The sender requests the narrow `firebase.messaging` OAuth scope; the daily aggregate reader requests `cloud-platform`, as required by the Data API.
4. Confirm the non-secret `FCM_ANDROID_APP_ID` binding is `1:190599692413:android:316a5d23e2888ac6ce7114` and the cron is `17 3 * * *` (03:17 UTC daily).
5. Do not enable Google Analytics or BigQuery export for this change. Neither is required by the FCM Data API.

## Separately authorized rollout

1. Deploy the queue worker only after CI, review, and explicit production approval.
2. Confirm the Worker reports one scheduled invocation per day.
3. Filter structured logs by `fcm_delivery_metrics_complete` and verify `pageCount`, `rowCount`, and `discardedRowCount` remain bounded.
4. Filter `fcm_delivery_metrics_row` with `analyticsLabel = alook_chat_notification_v1`. Trend these fields by `date`:
   - accepted: `countMessagesAccepted`, `countNotificationsAccepted`
   - outcome: `delivered`, `pending`, `collapsed`, and all documented drop causes
   - performance: no-delay, offline, Doze, throttled, and stopped-user delay percentages
   - insight: `priorityLowered`
   - notification proxy: proxied, failed, and each skipped reason
5. Alert on repeated `fcm_delivery_metrics_failed`, sustained nonzero `priorityLowered`, or material increases in Doze/offline/force-stop/inactive outcomes. Investigate trends; do not treat one aggregate row as a device receipt.

## Interpretation limits

- Data is best-effort, rounded, privacy-thresholded, and limited to devices that opted into usage and diagnostics collection.
- Rows cover the seven most recent days and can arrive up to five days late. A missing recent date is not proof of a collection failure.
- Percentages are aggregate per app, date, and analytics label. They cannot confirm that a specific Xiaomi device or message displayed a notification.
- High priority lets FCM wake a sleeping Android device for time-sensitive, user-visible notifications. Android may lower priority when messages do not lead to visible notifications.
- Force-stopped apps remain an operating-system boundary; server priority cannot override a user force-stop.

## Deferred physical-device validation

After an approved deployment, run a Xiaomi physical-device matrix covering foreground, background, recent-task swipe, several-hour idle/Doze, network reconnection, and explicit force-stop. Record both the visible-device outcome and the delayed aggregate trend when it becomes available. Until then, describe this change as an FCM priority and observability improvement, not as a verified Xiaomi fix.

## Primary references

- [Set and manage Android message priority](https://firebase.google.com/docs/cloud-messaging/android-message-priority)
- [Understand message delivery](https://firebase.google.com/docs/cloud-messaging/understand-delivery)
- [FCM Data API `deliveryData.list`](https://firebase.google.com/docs/reference/fcmdata/rest/v1beta1/projects.androidApps.deliveryData/list)
- [Google Cloud IAM permissions for FCM Data API](https://cloud.google.com/iam/docs/roles-permissions/fcmdata)
