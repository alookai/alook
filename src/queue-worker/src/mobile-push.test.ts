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
    deps.sendApns.mockRejectedValue(new Error("provider unavailable"))

    await expect(processMobilePush({} as never, env, task, deps)).resolves.toMatchObject({
      outcome: "processed",
      attempted: 2,
      sent: 0,
      invalidated: 1,
      failed: 1,
    })
    expect(deps.sendFcm).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify([
      ...mockLogInfo.mock.calls,
      ...mockLogWarn.mock.calls,
    ])
    expect(logged).not.toContain("private message body")
    expect(logged).not.toContain("plain-ciphertext")
    expect(logged).not.toContain("encryption-key")
  })

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
