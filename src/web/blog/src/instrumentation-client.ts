import { bootstrapObservability, onObservedRouterTransition } from "@/lib/observability/client"

bootstrapObservability("blog")
export function onRouterTransitionStart(url: string) { onObservedRouterTransition(url) }
