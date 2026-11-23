import { isTauri } from "@alook/shared"
import { bootstrapGoogleAnalytics, updateGooglePageFields } from "@/lib/analytics-consent"

if (!isTauri()) bootstrapGoogleAnalytics()
export function onRouterTransitionStart(url: string) {
  if (!isTauri()) updateGooglePageFields(url)
}
