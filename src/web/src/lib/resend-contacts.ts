import { createLogger } from "@alook/shared"
import { Resend } from "resend"

const log = createLogger({ service: "resend-contacts" })
const NEW_SIGNUPS_SEGMENT_ID = "6701946e-a7e2-442b-8fa5-aba379a81248"
export const BLOG_NEWSLETTER_SEGMENT_ID = "f0addb32-6c99-424e-9876-95d9695f86d0"

type ContactAction = "signup" | "account-deletion" | "newsletter-subscribe"
type ContactStage = "lookup" | "create" | "update" | "segment" | "event"
export type NewsletterSubscribeOutcome = "subscribed" | "unavailable" | "failed"

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
    let contactId: string
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
      if (created.error) {
        logProviderFailure("signup", stage, created.error.statusCode)
        return
      }
      contactId = created.data.id
    } else {
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
      if (added.error) {
        logProviderFailure("signup", stage, added.error.statusCode)
        return
      }
      if (contact.data.unsubscribed) return
      contactId = contact.data.id
    }

    stage = "event"
    const sent = await resend.events.send({ event: "new_signup", contactId })
    if (sent.error) logProviderFailure("signup", stage, sent.error.statusCode)
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

export async function subscribeResendNewsletter(
  env: Env,
  email: string,
): Promise<NewsletterSubscribeOutcome> {
  if (!env.RESEND_API_KEY) return "unavailable"
  let stage: ContactStage = "lookup"
  try {
    const resend = new Resend(env.RESEND_API_KEY)
    const contact = await resend.contacts.get({ email })
    if (contact.error) {
      if (contact.error.name !== "not_found" || contact.error.statusCode !== 404) {
        logProviderFailure("newsletter-subscribe", stage, contact.error.statusCode)
        return "failed"
      }
      stage = "create"
      const created = await resend.contacts.create({
        email,
        unsubscribed: false,
        segments: [{ id: BLOG_NEWSLETTER_SEGMENT_ID }],
      })
      if (created.error) {
        logProviderFailure("newsletter-subscribe", stage, created.error.statusCode)
        return "failed"
      }
      if (!created.data?.id) {
        log.warn("resend_contact_sync_failed", {
          action: "newsletter-subscribe",
          stage,
          errorCategory: "exception",
        })
        return "failed"
      }
      return "subscribed"
    }

    if (!contact.data?.id) {
      log.warn("resend_contact_sync_failed", {
        action: "newsletter-subscribe",
        stage: "update",
        errorCategory: "exception",
      })
      return "failed"
    }

    if (contact.data.unsubscribed) {
      stage = "update"
      const updated = await resend.contacts.update({
        id: contact.data.id,
        unsubscribed: false,
      })
      if (updated.error) {
        logProviderFailure("newsletter-subscribe", stage, updated.error.statusCode)
        return "failed"
      }
    }

    stage = "segment"
    const added = await resend.contacts.segments.add({
      contactId: contact.data.id,
      segmentId: BLOG_NEWSLETTER_SEGMENT_ID,
    })
    if (added.error) {
      logProviderFailure("newsletter-subscribe", stage, added.error.statusCode)
      return "failed"
    }
    return "subscribed"
  } catch {
    log.warn("resend_contact_sync_failed", {
      action: "newsletter-subscribe",
      stage,
      errorCategory: "exception",
    })
    return "failed"
  }
}
