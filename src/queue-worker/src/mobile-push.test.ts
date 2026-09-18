import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockLogInfo, mockLogWarn } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
}))
vi.mock("@alook/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@alook/shared")>()
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: mockLogInfo,
      warn: mockLogWarn,
      error: vi.fn(),
      child() { return this },
    }),
  }
})

import { processMobilePush } from "./mobile-push"
import {
  PushProviderError,
  type PushProviderStage,
} from "./providers/diagnostics"

const task = {
  version: 1 as const,
  kind: "mobile-push" as const,
  messageId: "message-1",
  userId: "user-1",
}

type Eligibility = {
  currentLevel: "all" | "mentions" | "nothing"
  hasAttention: boolean
  isUnread: boolean
  isReadable: boolean
}

const eligible: Eligibility = {
  currentLevel: "all" as const,
  hasAttention: false,
  isUnread: true,
  isReadable: true,
}

const target = {
  messageId: "message-1",
  channelId: "channel-1",
  authorName: "Alice",
  content: "private message body",
  conversationKind: "dm" as const,
  serverName: null,
  channelName: null,
  parentChannelName: null,
  attachmentContentTypes: [],
}

function dependencies() {
  return {
    resolveEligibility: vi.fn(async (): Promise<Map<string, Eligibility>> => (
      new Map([[task.userId, eligible]])
    )),
    getTarget: vi.fn(async () => target),
    listDevices: vi.fn(async () => [
      {
        id: "device-ios",
        installationId: "installation-ios",
        platform: "ios" as const,
        providerEnvironment: "sandbox" as const,
        providerTokenEncrypted: "ciphertext-ios",
      },
      {
        id: "device-android",
        installationId: "installation-android",
        platform: "android" as const,
        providerEnvironment: "production" as const,
        providerTokenEncrypted: "ciphertext-android",
      },
    ]),
    disableDevice: vi.fn(async () => true),
    decrypt: vi.fn((value: string) => `plain-${value}`),
    buildPayload: vi.fn(async () => ({
      notificationId: "notification-1",
      title: "Alice",
      body: "private message body",
      route: {
        notificationId: "notification-1",
        messageId: "message-1",
        targetId: "channel-1",
      },
    })),
    createFcmAccessToken: vi.fn(async () => "access-token"),
    sendApns: vi.fn(async () => ({ outcome: "sent" as const })),
    sendFcm: vi.fn(async () => ({ outcome: "invalid-token" as const })),
  }
}

const env = {
  ENCRYPTION_KEY: "encryption-key",
  APNS_TEAM_ID: "apns-team",
  APNS_KEY_ID: "apns-key",
  APNS_PRIVATE_KEY: "apns-private-key",
  APNS_TOPIC: "app.test",
  FCM_PROJECT_ID: "fcm-project",
  FCM_CLIENT_EMAIL: "fcm@example.test",
  FCM_PRIVATE_KEY: "fcm-private-key",
} as Env

describe("mobile-push processing", () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    ["message missing", undefined, "message_missing"],
    ["forbidden", { ...eligible, isReadable: false }, "forbidden"],
    ["already read", { ...eligible, isUnread: false }, "already_read"],
    ["muted", { ...eligible, currentLevel: "nothing" }, "muted"],
    ["mention-only without attention", { ...eligible, currentLevel: "mentions" }, "mention_only"],
  ])("skips %s before loading content or devices", async (_name, state, reason) => {
    const deps = dependencies()
    deps.resolveEligibility.mockResolvedValue(new Map<string, Eligibility>(
      state ? [[task.userId, state as Eligibility]] : [],
    ))

    await expect(processMobilePush({} as never, env, task, deps)).resolves.toEqual({
      outcome: "skip",
      reason,
    })
    expect(deps.getTarget).not.toHaveBeenCalled()
    expect(deps.listDevices).not.toHaveBeenCalled()
  })

  it("attempts every active device independently and soft-disables an invalid token", async () => {
    const deps = dependencies()

    await expect(processMobilePush({} as never, env, task, deps)).resolves.toEqual({
      outcome: "processed",
      attempted: 2,
      sent: 1,
      invalidated: 1,
      failed: 0,
    })
    expect(deps.decrypt).toHaveBeenCalledTimes(2)
    expect(deps.sendApns).toHaveBeenCalledWith(expect.objectContaining({
      providerToken: "plain-ciphertext-ios",
      providerEnvironment: "sandbox",
    }))
    expect(deps.sendFcm).toHaveBeenCalledWith(expect.objectContaining({
      providerToken: "plain-ciphertext-android",
      accessToken: "access-token",
    }))
    expect(deps.disableDevice).toHaveBeenCalledWith({}, {
      userId: "user-1",
      installationId: "installation-android",
      now: expect.any(String),
    })
  })

  it("continues siblings and returns a caught failure without logging content or tokens", async () => {
    const deps = dependencies()
    deps.sendApns.mockRejectedValue(new PushProviderError(
      "apns",
      "provider_send",
      503,
      "sensitive-provider-reason",
    ))

    await expect(processMobilePush({} as never, env, task, deps)).resolves.toMatchObject({
      outcome: "processed",
      attempted: 2,
      sent: 0,
      invalidated: 1,
      failed: 1,
    })
    expect(deps.sendFcm).toHaveBeenCalledTimes(1)
    expect(mockLogWarn).toHaveBeenCalledWith("mobile_push_device_failed", {
      messageId: "message-1",
      deviceId: "device-ios",
      provider: "apns",
      stage: "provider_send",
      errorName: "PushProviderError",
      httpStatus: 503,
      durationMs: expect.any(Number),
    })
    expect(Object.keys(mockLogWarn.mock.calls[0]![1]).sort()).toEqual([
      "deviceId",
      "durationMs",
      "errorName",
      "httpStatus",
      "messageId",
      "provider",
      "stage",
    ])
    const logged = JSON.stringify([
      ...mockLogInfo.mock.calls,
      ...mockLogWarn.mock.calls,
    ])
    expect(logged).not.toContain("private message body")
    expect(logged).not.toContain("plain-ciphertext")
    expect(logged).not.toContain("encryption-key")
    expect(logged).not.toContain("sensitive-provider-reason")
  })

  it("classifies decrypt failures without logging ciphertext or raw error details", async () => {
    const deps = dependencies()
    deps.listDevices.mockResolvedValue([{
      id: "device-ios",
      installationId: "installation-ios",
      platform: "ios" as const,
      providerEnvironment: "sandbox" as const,
      providerTokenEncrypted: "sensitive-ciphertext",
    }])
    const rawError = new Error("sensitive-decrypt-message")
    rawError.name = "TypeError"
    rawError.stack = "sensitive-decrypt-stack"
    deps.decrypt.mockImplementation(() => { throw rawError })

    await expect(processMobilePush({} as never, env, task, deps)).resolves.toEqual({
      outcome: "processed",
      attempted: 1,
      sent: 0,
      invalidated: 0,
      failed: 1,
    })
    expect(mockLogWarn).toHaveBeenCalledWith("mobile_push_device_failed", {
      messageId: "message-1",
      deviceId: "device-ios",
      provider: "apns",
      stage: "decrypt",
      errorName: "TypeError",
      durationMs: expect.any(Number),
    })
    const logged = JSON.stringify(mockLogWarn.mock.calls)
    for (const sentinel of [
      "sensitive-ciphertext",
      "sensitive-decrypt-message",
      "sensitive-decrypt-stack",
    ]) {
      expect(logged).not.toContain(sentinel)
    }
  })

  it("drops unapproved HTTP statuses and error names from failure logs", async () => {
    const deps = dependencies()
    deps.listDevices.mockResolvedValue([{
      id: "device-android",
      installationId: "installation-android",
      platform: "android" as const,
      providerEnvironment: "production" as const,
      providerTokenEncrypted: "ciphertext-android",
    }])
    deps.sendFcm.mockRejectedValue(new PushProviderError(
      "fcm",
      "provider_send",
      418,
      "sensitive-provider-reason",
      "SensitiveInternalError",
    ))

    await processMobilePush({} as never, env, task, deps)

    expect(mockLogWarn).toHaveBeenCalledWith("mobile_push_device_failed", {
      messageId: "message-1",
      deviceId: "device-android",
      provider: "fcm",
      stage: "provider_send",
      errorName: "unknown",
      durationMs: expect.any(Number),
    })
    const logged = JSON.stringify(mockLogWarn.mock.calls)
    expect(logged).not.toContain("418")
    expect(logged).not.toContain("sensitive-provider-reason")
    expect(logged).not.toContain("SensitiveInternalError")
  })

  it.each([
    ["apns", "credential_fingerprint", "sendApns", undefined],
    ["apns", "key_import", "sendApns", undefined],
    ["apns", "sign", "sendApns", undefined],
    ["apns", "provider_send", "sendApns", 503],
    ["fcm", "key_import", "createFcmAccessToken", undefined],
    ["fcm", "sign", "createFcmAccessToken", undefined],
    ["fcm", "oauth_fetch", "createFcmAccessToken", 503],
    ["fcm", "provider_send", "sendFcm", 503],
  ] as const)(
    "logs only approved keys for %s/%s failures",
    async (provider, stage, dependency, httpStatus) => {
      const deps = dependencies()
      const listedDevices = await deps.listDevices()
      deps.listDevices.mockResolvedValue(listedDevices.filter(
        (device) => device.platform === (provider === "apns" ? "ios" : "android"),
      ))
      const failure = new PushProviderError(
        provider,
        stage as PushProviderStage,
        httpStatus,
        "sensitive-stage-reason",
      )
      deps[dependency].mockRejectedValue(failure)

      await expect(processMobilePush({} as never, env, task, deps)).resolves.toMatchObject({
        outcome: "processed",
        attempted: 1,
        failed: 1,
      })

      const expectedDetails = {
        messageId: "message-1",
        deviceId: provider === "apns" ? "device-ios" : "device-android",
        provider,
        stage,
        errorName: "PushProviderError",
        ...(httpStatus === undefined ? {} : { httpStatus }),
        durationMs: expect.any(Number),
      }
      expect(mockLogWarn).toHaveBeenCalledWith("mobile_push_device_failed", expectedDetails)
      expect(Object.keys(mockLogWarn.mock.calls[0]![1]).sort())
        .toEqual(Object.keys(expectedDetails).sort())
      const logged = JSON.stringify(mockLogWarn.mock.calls)
      for (const sentinel of [
        "sensitive-stage-reason",
        "private message body",
        "plain-ciphertext",
        "encryption-key",
        "access-token",
      ]) {
        expect(logged).not.toContain(sentinel)
      }
    },
  )

  it("skips when no active devices remain", async () => {
    const deps = dependencies()
    deps.listDevices.mockResolvedValue([])

    await expect(processMobilePush({} as never, env, task, deps)).resolves.toEqual({
      outcome: "skip",
      reason: "no_active_devices",
    })
    expect(deps.buildPayload).not.toHaveBeenCalled()
  })
})
