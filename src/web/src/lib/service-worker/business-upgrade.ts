import { BUSINESS_SCHEMA_VERSION } from "@alook/shared/business-schema-version"
import { resolveCommunityModulePlan } from "../community/community-route"
import { isCommunityApplicationPath } from "../community/application-route"

export const BUSINESS_UPDATE_MARKER = "__alook_schema_update"
export const DOCUMENT_VERSION_PROBE = "alook:document-version"
export const WORKER_VERSION_PROBE = "alook:worker-version"
export const CURRENT_DOCUMENT_REQUEST = "alook:current-document"

export const businessDocumentVersionBootstrapScript = `
try {
  if ("serviceWorker" in navigator) {
    const container = navigator.serviceWorker;
    container.addEventListener("message", (event) => {
      if (event.data?.type === ${JSON.stringify(DOCUMENT_VERSION_PROBE)}) {
        event.ports[0]?.postMessage({ schemaVersion: ${BUSINESS_SCHEMA_VERSION} });
      }
    });
    container.startMessages();
  }
} catch {}
`

type MessageTarget = { postMessage(message: unknown, transfer: Transferable[]): void }

export function probeBusinessVersion(target: MessageTarget, type: string, timeout = 1500): Promise<number | null> {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const finish = (version: number | null) => {
      clearTimeout(timer)
      channel.port1.close()
      channel.port2.close()
      resolve(version)
    }
    const timer = setTimeout(() => finish(null), timeout)
    channel.port1.onmessage = event => finish(Number.isSafeInteger(event.data?.schemaVersion) ? event.data.schemaVersion : null)
    try { target.postMessage({ type }, [channel.port2]) } catch { finish(null) }
  })
}

function isBusinessDocumentPath(pathname: string) {
  return isCommunityApplicationPath(pathname) || resolveCommunityModulePlan(pathname).route === "public-invite"
}

export function businessUpdateUrl(href: string, version: number): string | null {
  const url = new URL(href)
  if (!isBusinessDocumentPath(url.pathname) || url.searchParams.get(BUSINESS_UPDATE_MARKER) === String(version)) return null
  url.searchParams.set(BUSINESS_UPDATE_MARKER, String(version))
  return url.href
}

export async function upgradeBusinessWindow(client: MessageTarget & { url: string; navigate(url: string): Promise<unknown> }, origin: string, force = false, explicitRetry = false): Promise<boolean> {
  const url = new URL(client.url)
  if (url.origin !== origin || !isBusinessDocumentPath(url.pathname)) return false
  if (!force && await probeBusinessVersion(client, DOCUMENT_VERSION_PROBE) === BUSINESS_SCHEMA_VERSION) return false
  if (explicitRetry) url.searchParams.delete(BUSINESS_UPDATE_MARKER)
  const next = businessUpdateUrl(url.href, BUSINESS_SCHEMA_VERSION)
  if (!next) return false
  return Boolean(await client.navigate(next))
}
