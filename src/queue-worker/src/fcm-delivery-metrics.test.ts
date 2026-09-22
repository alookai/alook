import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockLogInfo } = vi.hoisted(() => ({ mockLogInfo: vi.fn() }))
vi.mock("@alook/shared", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mockLogInfo,
    warn: vi.fn(),
    error: vi.fn(),
    child() { return this },
  }),
}))

import { collectFcmDeliveryMetrics } from "./fcm-delivery-metrics"
import { FCM_ANDROID_ANALYTICS_LABEL } from "./providers/fcm"

const env = {
  FCM_PROJECT_ID: "test-project",
  FCM_CLIENT_EMAIL: "test@example.test",
  FCM_PRIVATE_KEY: "private-key",
  FCM_ANDROID_APP_ID: "test-app",
} as unknown as Env

describe("FCM delivery metrics collector", () => {
  beforeEach(() => vi.clearAllMocks())

  it("logs only projected aggregate rows and a bounded completion summary", async () => {
    const createAccessToken = vi.fn(async () => "access-token")
    const listDeliveryData = vi.fn(async () => ({
      rows: [{
        date: "2026-09-20",
        countMessagesAccepted: "12",
        messageOutcomePercents: { delivered: 95, droppedAppForceStopped: 5 },
        deliveryPerformancePercents: { delayedDeviceDoze: 4 },
        messageInsightPercents: { priorityLowered: 3 },
        proxyNotificationInsightPercents: { proxied: 20 },
      }],
      pageCount: 2,
      discardedRowCount: 1,
    }))

    await collectFcmDeliveryMetrics(env, {
      createAccessToken,
      listDeliveryData,
    })

    expect(createAccessToken).toHaveBeenCalledWith({
      projectId: "test-project",
      clientEmail: "test@example.test",
      privateKey: "private-key",
    })
    expect(listDeliveryData).toHaveBeenCalledWith({
      projectId: "test-project",
      appId: "test-app",
      accessToken: "access-token",
    })
    expect(mockLogInfo).toHaveBeenNthCalledWith(1, "fcm_delivery_metrics_row", {
      analyticsLabel: FCM_ANDROID_ANALYTICS_LABEL,
      date: "2026-09-20",
      countMessagesAccepted: "12",
      messageOutcomePercents: { delivered: 95, droppedAppForceStopped: 5 },
      deliveryPerformancePercents: { delayedDeviceDoze: 4 },
      messageInsightPercents: { priorityLowered: 3 },
      proxyNotificationInsightPercents: { proxied: 20 },
    })
    expect(mockLogInfo).toHaveBeenNthCalledWith(2, "fcm_delivery_metrics_complete", {
      analyticsLabel: FCM_ANDROID_ANALYTICS_LABEL,
      rowCount: 1,
      pageCount: 2,
      discardedRowCount: 1,
    })
    expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain("private-key")
    expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain("access-token")
    expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain("test-app")
  })

  it.each([
    ["FCM_PROJECT_ID"],
    ["FCM_CLIENT_EMAIL"],
    ["FCM_PRIVATE_KEY"],
    ["FCM_ANDROID_APP_ID"],
  ] as const)("rejects an empty %s before authentication", async (key) => {
    const createAccessToken = vi.fn()
    await expect(collectFcmDeliveryMetrics({ ...env, [key]: "" }, {
      createAccessToken,
      listDeliveryData: vi.fn(),
    })).rejects.toMatchObject({ provider: "fcm", stage: "configuration" })
    expect(createAccessToken).not.toHaveBeenCalled()
    expect(mockLogInfo).not.toHaveBeenCalled()
  })
})
