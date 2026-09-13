# Queue resource migration runbook

This runbook moves the existing wake-only resources to the generic queue names. It is deliberately a create/cutover/drain migration: Cloudflare Queue names cannot be changed in place.

The companion `scripts/cloudflare/queue-migration.mjs` only prints the plan. It never invokes Wrangler and rejects `--execute`. Do not run any mutating command below without its own production authorization.

## Invariants

- New code accepts legacy `{ messageId, botUserId }` wake payloads plus both v1 task kinds.
- Web has exactly one queue producer binding. Never dual-write old and new queues.
- Keep `alook-wake-worker` consuming `alook-wake` throughout the drain.
- Do not delete a legacy resource until its depth and oldest-message age remain zero, no old producer exists, and new wake traffic is healthy.
- Creating resources, deploying code, configuring real provider secrets, and deleting resources are separate production actions.

## Authorized sequence

1. Prepare: create `alook-queue` and `alook-queue-dlq`. Confirm neither has a producer.
2. Compatible consumer: deploy `alook-queue-worker`, bound to the new Queue/DLQ, the existing D1 database, and the WS service. Set the same `ENCRYPTION_KEY` used by Web; configure APNs/FCM values separately. Verify legacy wake, v1 bot-wake, and v1 mobile-push parsing with non-production fixtures only.
3. Producer cutover: deploy Web with `TASK_QUEUE` targeting only `alook-queue` and `QUEUE_WORKER` targeting `alook-queue-worker`. Confirm the old producer binding is absent.
4. Drain and observe: use read-only queue metrics to verify `alook-wake` depth and oldest age reach zero. Confirm no old producer remains, bot wakes traverse the new chain, caught mobile-push failures are ACKed, and the new DLQ is observed.
5. Cleanup: stop. Obtain separate exact authorization, then delete `alook-wake`, `alook-wake-dlq`, and `alook-wake-worker` only. Re-run read-only checks after deletion.

## Rollback boundary

Before cleanup, roll back by returning the single Web producer binding to `alook-wake`; do not send to both queues. After cleanup, rollback requires recreating the legacy resources and therefore needs a new production plan and authorization.
