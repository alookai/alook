import { installReactScan } from "@/lib/perf/react-scan-install"
import { bootstrapObservability, onObservedRouterTransition } from "@/lib/observability/client"
import { isTauri } from "@alook/shared"
import { bootstrapGoogleAnalytics, updateGooglePageFields } from "@/lib/analytics-consent"

if (!isTauri()) bootstrapGoogleAnalytics()
bootstrapObservability("web")
export function onRouterTransitionStart(url: string) {
  if (!isTauri()) updateGooglePageFields(url)
  onObservedRouterTransition(url)
}

// Fire-and-forget: the guard inside is synchronous, only the dynamic
// react-scan import is async. Any failure is swallowed so instrumentation can
// never break app boot.
void installReactScan().catch(() => {})
