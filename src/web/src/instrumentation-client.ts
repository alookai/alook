import { installSessionTransport } from "@/lib/session-transport"
import { installReactScan } from "@/lib/perf/react-scan-install"
import { isTauri } from "@alook/shared"
import { bootstrapGoogleAnalytics, updateGooglePageFields } from "@/lib/analytics-consent"

installSessionTransport()
if (!isTauri()) bootstrapGoogleAnalytics()
export function onRouterTransitionStart(url: string) {
  if (!isTauri()) updateGooglePageFields(url)
}

// Fire-and-forget: the guard inside is synchronous, only the dynamic
// react-scan import is async. Any failure is swallowed so instrumentation can
// never break app boot.
void installReactScan().catch(() => {})
