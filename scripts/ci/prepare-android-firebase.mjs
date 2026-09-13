import { chmodSync, writeFileSync } from "node:fs"

export function prepareAndroidFirebase(raw, target) {
  let config
  try {
    config = JSON.parse(raw ?? "")
  } catch {
    throw new Error("ANDROID_GOOGLE_SERVICES_JSON must contain valid Firebase client JSON")
  }
  const project = config?.project_info
  const client = config?.client?.find?.(
    (entry) => entry?.client_info?.android_client_info?.package_name === "ai.alook.android",
  )
  if (
    project?.project_id !== "alook-prod" ||
    project?.project_number !== "190599692413" ||
    client?.client_info?.mobilesdk_app_id !== "1:190599692413:android:316a5d23e2888ac6ce7114" ||
    !client?.api_key?.some?.((entry) => typeof entry?.current_key === "string" && entry.current_key.trim())
  ) {
    throw new Error("Firebase client configuration must match the registered alook-prod Android app")
  }
  writeFileSync(target, raw, { mode: 0o600 })
  chmodSync(target, 0o600)
}
