import { createLogger } from "@alook/shared"
import {
  createFcmDataAccessToken,
  FCM_ANDROID_ANALYTICS_LABEL,
  listFcmAndroidDeliveryData,
} from "./providers/fcm"
import { PushProviderError } from "./providers/diagnostics"

const log = createLogger({ service: "queue-worker-fcm-delivery-metrics" })

type FcmDeliveryMetricsEnv = Pick<
  Env,
  "FCM_PROJECT_ID" | "FCM_CLIENT_EMAIL" | "FCM_PRIVATE_KEY" | "FCM_ANDROID_APP_ID"
>

type FcmDeliveryMetricsDependencies = {
  createAccessToken: typeof createFcmDataAccessToken
  listDeliveryData: typeof listFcmAndroidDeliveryData
}

function requireConfig(value: string): string {
  if (!value.trim()) {
    throw new PushProviderError("fcm", "configuration", undefined, "missing_delivery_metrics_config")
  }
  return value
}

export async function collectFcmDeliveryMetrics(
  env: FcmDeliveryMetricsEnv,
  dependencies: FcmDeliveryMetricsDependencies = {
    createAccessToken: createFcmDataAccessToken,
    listDeliveryData: listFcmAndroidDeliveryData,
  },
): Promise<void> {
  const config = {
    projectId: requireConfig(env.FCM_PROJECT_ID),
    clientEmail: requireConfig(env.FCM_CLIENT_EMAIL),
    privateKey: requireConfig(env.FCM_PRIVATE_KEY),
  }
  const appId = requireConfig(env.FCM_ANDROID_APP_ID)
  const accessToken = await dependencies.createAccessToken(config)
  const result = await dependencies.listDeliveryData({
    projectId: config.projectId,
    appId,
    accessToken,
  })

  for (const row of result.rows) {
    log.info("fcm_delivery_metrics_row", {
      analyticsLabel: FCM_ANDROID_ANALYTICS_LABEL,
      ...row,
    })
  }
  log.info("fcm_delivery_metrics_complete", {
    analyticsLabel: FCM_ANDROID_ANALYTICS_LABEL,
    rowCount: result.rows.length,
    pageCount: result.pageCount,
    discardedRowCount: result.discardedRowCount,
  })
}
