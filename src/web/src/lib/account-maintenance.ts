import { createLogger, queries } from "@alook/shared"
import { getPrimaryDb } from "./db"
import { executeAccountDeletion } from "./account-deletion/execution"
import { billingClient } from "./billing/client"
import { reconcileBilling } from "./billing/reconcile"

const log = createLogger({ service: "account-maintenance" })
const billingCursorKey = "account-maintenance:billing-cursor"

export async function maintainAccounts(env: Env, ctx: Pick<ExecutionContext, "waitUntil">) {
  const db = getPrimaryDb(env.DB)
  const deletionDeadline = Date.now() + 4 * 60_000
  for (const { id } of await queries.accountDeletion.listPendingAccountDeletions(db)) {
    if (Date.now() >= deletionDeadline) break
    await executeAccountDeletion(db, env, ctx, id)
  }
  const billingDeadline = Date.now() + 4 * 60_000
  let cursor: queries.billing.BillingRecoveryCursor | undefined
  try {
    const saved = await env.CACHE_KV.get<queries.billing.BillingRecoveryCursor>(billingCursorKey, "json")
    if (saved && typeof saved.updatedAt === "string" && typeof saved.userId === "string") cursor = saved
  } catch { log.warn("billing_recovery_cursor_read_failed") }
  const seen = new Set<string>()
  let advanced = false
  let persistCursor = true
  let restarted = false
  try {
    while (Date.now() < billingDeadline && seen.size < 25) {
      const page = await queries.billing.listBillingRecoveryPage(db, cursor)
      if (page.length === 0) {
        if (!restarted && cursor && seen.size === 0) { cursor = undefined; restarted = true; continue }
        break
      }
      for (const row of page) {
        if (Date.now() >= billingDeadline || seen.size >= 25) break
        cursor = { updatedAt: row.updatedAt, userId: row.userId }
        advanced = true
        if (row.deletedAt !== null || seen.has(row.userId)) continue
        seen.add(row.userId)
        let recorded = false
        try {
          await queries.billing.recordBillingRecoveryAttempt(db, row.userId)
          recorded = true
          await reconcileBilling(db, billingClient(env), env, row.userId)
        } catch {
          if (!recorded) persistCursor = false
          log.warn("billing_recovery_failed", { userId: row.userId })
        }
      }
    }
  } finally {
    if (advanced && persistCursor && cursor) {
      try { await env.CACHE_KV.put(billingCursorKey, JSON.stringify(cursor)) }
      catch { log.warn("billing_recovery_cursor_write_failed") }
    }
  }
}
