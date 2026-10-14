import { createLogger } from "@alook/shared"
import { Resend } from "resend"

const log = createLogger({ service: "resend-contacts" })
const NEW_SIGNUPS_SEGMENT_ID = "6701946e-a7e2-442b-8fa5-aba379a81248"

type ContactAction = "signup" | "account-deletion"
type ContactStage = "lookup" | "create" | "update" | "segment"

function logProviderFailure(
  action: ContactAction,
  stage: ContactStage,
  statusCode: number | null,
): void {
  log.warn("resend_contact_sync_failed", {
    action,
    stage,
    errorCategory: "provider_error",
    ...(Number.isInteger(statusCode) && statusCode !== null && statusCode >= 100 && statusCode <= 599
      ? { statusCode }
      : {}),
  })
}

export async function syncResendSignupContact(
  env: Env,
  user: { email: string; name: string },
): Promise<void> {
  if (!env.RESEND_API_KEY) return
  let stage: ContactStage = "lookup"
  try {
    const resend = new Resend(env.RESEND_API_KEY)
    const contact = await resend.contacts.get({ email: user.email })
    if (contact.error) {
      if (contact.error.name !== "not_found" || contact.error.statusCode !== 404) {
        logProviderFailure("signup", stage, contact.error.statusCode)
        return
      }
      stage = "create"
      const created = await resend.contacts.create({
        email: user.email,
        firstName: user.name,
        segments: [{ id: NEW_SIGNUPS_SEGMENT_ID }],
      })
      if (created.error) logProviderFailure("signup", stage, created.error.statusCode)
      return
    }

    stage = "update"
    const updated = await resend.contacts.update({ id: contact.data.id, firstName: user.name })
    if (updated.error) {
      logProviderFailure("signup", stage, updated.error.statusCode)
      return
    }
    stage = "segment"
    const added = await resend.contacts.segments.add({
      contactId: contact.data.id,
      segmentId: NEW_SIGNUPS_SEGMENT_ID,
    })
    if (added.error) logProviderFailure("signup", stage, added.error.statusCode)
  } catch {
    log.warn("resend_contact_sync_failed", { action: "signup", stage, errorCategory: "exception" })
  }
}

export async function unsubscribeResendContact(env: Env, email: string): Promise<void> {
  if (!env.RESEND_API_KEY) return
  try {
    const resend = new Resend(env.RESEND_API_KEY)
    const updated = await resend.contacts.update({ email, unsubscribed: true })
    if (updated.error) logProviderFailure("account-deletion", "update", updated.error.statusCode)
  } catch {
    log.warn("resend_contact_sync_failed", {
      action: "account-deletion",
      stage: "update",
      errorCategory: "exception",
    })
  }
}
