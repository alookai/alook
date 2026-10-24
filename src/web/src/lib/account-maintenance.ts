import { createLogger, queries } from "@alook/shared"
import { getPrimaryDb } from "./db"
import { executeAccountDeletion } from "./account-deletion/execution"
import { billingClient } from "./billing/client"
import { reconcileBilling } from "./billing/reconcile"

const log = createLogger({ service: "account-maintenance" })

export async function maintainAccounts(env: Env, ctx: Pick<ExecutionContext, "waitUntil">) {
  const db = getPrimaryDb(env.DB)
  const deletionDeadline = Date.now() + 4 * 60_000
  for (const { id } of await queries.accountDeletion.listPendingAccountDeletions(db)) {
    if (Date.now() >= deletionDeadline) break
    await executeAccountDeletion(db, env, ctx, id)
  }
  const billingDeadline = Date.now() + 4 * 60_000
  for (const { userId } of await queries.billing.listBillingOwners(db)) {
    if (Date.now() >= billingDeadline) break
    try {
      await queries.billing.recordBillingRecoveryAttempt(db, userId)
      await reconcileBilling(db, billingClient(env), env, userId)
    } catch {
      log.warn("billing_recovery_failed", { userId })
    }
  }
}
