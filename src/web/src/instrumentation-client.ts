// Next.js client instrumentation entry — runs before the app hydrates, i.e.
// before react-dom installs its DevTools global hook. This is the ONLY place
// early enough to register react-scan's instrument() and capture the initial
// mount (see plans/community-switch-perf-diagnosis.md).
//
// Distinct from the server-side `instrumentation.ts` `register()` hook — do not
// conflate them. This file is diagnosis-only and self-noops unless
// NEXT_PUBLIC_PERF_TRACE=1 in a non-production build.

import { installReactScan } from "@/lib/perf/react-scan-install"

// Fire-and-forget: the guard inside is synchronous, only the dynamic
// react-scan import is async. Any failure is swallowed so instrumentation can
// never break app boot.
void installReactScan().catch(() => {})
