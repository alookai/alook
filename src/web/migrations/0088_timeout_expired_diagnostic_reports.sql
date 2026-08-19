-- Close diagnostic rows that expired before receipt-driven alarms shipped.
-- New reports are expired by the ws-do alarm and daemon reconnect resync path;
-- this idempotent backfill is only the deploy-time bridge for legacy pending
-- rows (including the two reports stranded by the 2026-08-17 incident).
UPDATE community_diagnostic_report
SET status = 'failed',
    failure_code = 'timeout',
    completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE status = 'pending'
  AND deadline_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000;
