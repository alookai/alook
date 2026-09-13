import { createLogger, queries, type Database, type MobilePushQueueTaskV1 } from "@alook/shared"
import { decrypt } from "@alook/shared/crypto"
import { buildPushNotificationPayload } from "./notification-payload"
import { sendApnsNotification } from "./providers/apns"
import {
  createFcmAccessToken,
  sendFcmNotification,
} from "./providers/fcm"

const log = createLogger({ service: "queue-worker-mobile-push" })

type MobilePushSkipReason =
  | "message_missing"
  | "forbidden"
  | "already_read"
  | "muted"
  | "mention_only"
  | "no_active_devices"

export type MobilePushResult =
  | { outcome: "skip"; reason: MobilePushSkipReason }
  | {
      outcome: "processed"
      attempted: number
      sent: number
      invalidated: number
      failed: number
    }

type MobilePushDependencies = {
  resolveEligibility: typeof queries.communityNotificationEligibility.resolveNotificationEligibilityForUsers
  getTarget: typeof queries.communityNotificationTarget.getPushNotificationTarget
  listDevices: typeof queries.communityPushDevice.listActivePushDevices
  disableDevice: typeof queries.communityPushDevice.disablePushDevice
  decrypt: typeof decrypt
  buildPayload: typeof buildPushNotificationPayload
  createFcmAccessToken: typeof createFcmAccessToken
  sendApns: typeof sendApnsNotification
  sendFcm: typeof sendFcmNotification
}

const defaultDependencies: MobilePushDependencies = {
  resolveEligibility:
    queries.communityNotificationEligibility.resolveNotificationEligibilityForUsers,
  getTarget: queries.communityNotificationTarget.getPushNotificationTarget,
  listDevices: queries.communityPushDevice.listActivePushDevices,
  disableDevice: queries.communityPushDevice.disablePushDevice,
  decrypt,
  buildPayload: buildPushNotificationPayload,
  createFcmAccessToken,
  sendApns: sendApnsNotification,
  sendFcm: sendFcmNotification,
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

export async function processMobilePush(
  db: Database,
  env: Env,
  task: MobilePushQueueTaskV1,
  dependencies: MobilePushDependencies = defaultDependencies,
): Promise<MobilePushResult> {
  const eligibility = await dependencies.resolveEligibility(
    db,
    [task.userId],
    task.messageId,
  )
  const state = eligibility.get(task.userId)
  if (!state) return { outcome: "skip", reason: "message_missing" }
  if (!state.isReadable) return { outcome: "skip", reason: "forbidden" }
  if (!state.isUnread) return { outcome: "skip", reason: "already_read" }
  if (!queries.communityNotificationSetting.policyAllows(
    state.currentLevel,
    state.hasAttention,
  )) {
    return {
      outcome: "skip",
      reason: state.currentLevel === "nothing" ? "muted" : "mention_only",
    }
  }

  const [target, devices] = await Promise.all([
    dependencies.getTarget(db, task.messageId),
    dependencies.listDevices(db, task.userId),
  ])
  if (!target) return { outcome: "skip", reason: "message_missing" }
  if (devices.length === 0) return { outcome: "skip", reason: "no_active_devices" }

  const payload = await dependencies.buildPayload(target, task.userId)
  let fcmAccessToken: Promise<string> | undefined
  const results = await Promise.all(devices.map(async (device) => {
    const startedAt = Date.now()
    try {
      const providerToken = dependencies.decrypt(
        device.providerTokenEncrypted,
        required(env.ENCRYPTION_KEY, "ENCRYPTION_KEY"),
      )
      const providerResult = device.platform === "ios"
        ? await dependencies.sendApns({
            providerToken,
            providerEnvironment: device.providerEnvironment,
            payload,
            config: {
              teamId: required(env.APNS_TEAM_ID, "APNS_TEAM_ID"),
              keyId: required(env.APNS_KEY_ID, "APNS_KEY_ID"),
              privateKey: required(env.APNS_PRIVATE_KEY, "APNS_PRIVATE_KEY"),
              topic: required(env.APNS_TOPIC, "APNS_TOPIC"),
            },
          })
        : await dependencies.sendFcm({
            providerToken,
            accessToken: await (fcmAccessToken ??= dependencies.createFcmAccessToken({
              projectId: required(env.FCM_PROJECT_ID, "FCM_PROJECT_ID"),
              clientEmail: required(env.FCM_CLIENT_EMAIL, "FCM_CLIENT_EMAIL"),
              privateKey: required(env.FCM_PRIVATE_KEY, "FCM_PRIVATE_KEY"),
            })),
            payload,
            config: {
              projectId: required(env.FCM_PROJECT_ID, "FCM_PROJECT_ID"),
            },
          })

      if (providerResult.outcome === "invalid-token") {
        await dependencies.disableDevice(db, {
          userId: task.userId,
          installationId: device.installationId,
          now: new Date().toISOString(),
        })
      }
      log.info("mobile_push_device_complete", {
        kind: task.kind,
        messageId: task.messageId,
        userId: task.userId,
        deviceId: device.id,
        platform: device.platform,
        outcome: providerResult.outcome,
        durationMs: Date.now() - startedAt,
      })
      return providerResult.outcome
    } catch (error) {
      log.warn("mobile_push_device_failed", {
        kind: task.kind,
        messageId: task.messageId,
        userId: task.userId,
        deviceId: device.id,
        platform: device.platform,
        errorName: error instanceof Error ? error.name : "unknown",
        durationMs: Date.now() - startedAt,
      })
      return "failed" as const
    }
  }))

  return {
    outcome: "processed",
    attempted: devices.length,
    sent: results.filter((outcome) => outcome === "sent").length,
    invalidated: results.filter((outcome) => outcome === "invalid-token").length,
    failed: results.filter((outcome) => outcome === "failed").length,
  }
}
