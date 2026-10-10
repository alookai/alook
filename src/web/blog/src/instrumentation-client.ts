import { bootstrapObservability, onObservedRouterTransition } from "@/lib/observability/client"
import { isTauri } from "@alook/shared"
import { bootstrapGoogleAnalytics, updateGooglePageFields } from "@/lib/analytics-consent"

if (!isTauri()) bootstrapGoogleAnalytics()
bootstrapObservability("blog")
export function onRouterTransitionStart(url: string) {
  if (!isTauri()) updateGooglePageFields(url)
  onObservedRouterTransition(url)
}
