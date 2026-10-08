import { getCloudflareContext } from "@opennextjs/cloudflare"
import { cleanAttributes, type Attributes } from "./schema"

function requestTracing() {
  try { return getCloudflareContext().ctx.tracing } catch { return undefined }
}

export function annotateWorkerSpan(attributes: Attributes) {
  const span = requestTracing()?.getActiveSpan()
  if (span?.isTraced) for (const [key, value] of Object.entries(cleanAttributes(attributes))) span.setAttribute(key, value)
}

export function observeWorkerOperation<T>(name: string, attributes: Attributes, execute: () => T): T {
  const tracing = requestTracing()
  if (!tracing) return execute()
  return tracing.enterSpan(name, (span) => {
    for (const [key, value] of Object.entries(cleanAttributes(attributes))) span.setAttribute(key, value)
    return execute()
  })
}
