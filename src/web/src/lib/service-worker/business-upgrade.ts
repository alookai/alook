import { BUSINESS_SCHEMA_VERSION } from "@alook/shared/business-schema-version"
import { resolveCommunityModulePlan } from "../community/community-route"
import { isCommunityApplicationPath } from "../community/application-route"
import { WEB_BUILD_ID } from "../web-build"

export const BUSINESS_UPDATE_MARKER = "__alook_schema_update"
export const DOCUMENT_VERSION_PROBE = "alook:document-version"
export const WORKER_VERSION_PROBE = "alook:worker-version"
export const CURRENT_DOCUMENT_REQUEST = "alook:current-document"
export const DOCUMENT_UPDATE_AVAILABLE = "alook:document-update-available"
export type BusinessDocumentIdentity = { schemaVersion: number; buildId?: string }

export const businessDocumentVersionBootstrapScript = `
try {
  if ("serviceWorker" in navigator) {
    const container = navigator.serviceWorker;
    container.addEventListener("message", (event) => {
      if (event.data?.type === ${JSON.stringify(DOCUMENT_VERSION_PROBE)}) {
        event.ports[0]?.postMessage({ schemaVersion: ${BUSINESS_SCHEMA_VERSION}, buildId: ${JSON.stringify(WEB_BUILD_ID)} });
      }
    });
    container.startMessages();
  }
} catch {}
`

type MessageTarget = { postMessage(message: unknown, transfer: Transferable[]): void }

export function probeBusinessIdentity(target: MessageTarget, type: string, timeout = 1500): Promise<BusinessDocumentIdentity | null> {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const finish = (identity: BusinessDocumentIdentity | null) => {
      clearTimeout(timer)
      channel.port1.close()
      channel.port2.close()
      resolve(identity)
    }
    const timer = setTimeout(() => finish(null), timeout)
    channel.port1.onmessage = event => {
      const data = event.data
      finish(Number.isSafeInteger(data?.schemaVersion) && data.schemaVersion > 0 ? {
        schemaVersion: data.schemaVersion,
        ...(typeof data.buildId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(data.buildId) ? { buildId: data.buildId } : {}),
      } : null)
    }
    try { target.postMessage({ type }, [channel.port2]) } catch { finish(null) }
  })
}

export async function probeBusinessVersion(target: MessageTarget, type: string, timeout = 1500): Promise<number | null> {
  return (await probeBusinessIdentity(target, type, timeout))?.schemaVersion ?? null
}

export function isBusinessDocumentPath(pathname: string) {
  return isCommunityApplicationPath(pathname) || resolveCommunityModulePlan(pathname).route === "public-invite"
}

export function isCurrentBusinessDocument() {
  try { return typeof window !== "undefined" && isBusinessDocumentPath(new URL(window.location.href).pathname) } catch { return false }
}

export function businessUpdateMarker(version: number, buildId?: string): string {
  return buildId ? `${version}:${buildId}` : String(version)
}

export function businessUpdateUrl(href: string, version: number, buildId?: string): string | null {
  const url = new URL(href)
  const marker = businessUpdateMarker(version, buildId)
  if (!isBusinessDocumentPath(url.pathname) || url.searchParams.get(BUSINESS_UPDATE_MARKER) === marker) return null
  url.searchParams.set(BUSINESS_UPDATE_MARKER, marker)
  return url.href
}

export async function upgradeBusinessWindow(client: MessageTarget & { url: string; navigate(url: string): Promise<unknown> }, origin: string, force = false, explicitRetry = false): Promise<boolean> {
  const url = new URL(client.url)
  if (url.origin !== origin || !isBusinessDocumentPath(url.pathname)) return false
  if (!force) {
    const identity = await probeBusinessIdentity(client, DOCUMENT_VERSION_PROBE)
    if (identity?.schemaVersion === BUSINESS_SCHEMA_VERSION && identity.buildId === WEB_BUILD_ID) return false
    if (identity?.buildId) {
      client.postMessage({ type: DOCUMENT_UPDATE_AVAILABLE }, [])
      return false
    }
  }
  if (explicitRetry) url.searchParams.delete(BUSINESS_UPDATE_MARKER)
  const next = businessUpdateUrl(url.href, BUSINESS_SCHEMA_VERSION, WEB_BUILD_ID)
  if (!next) return false
  return Boolean(await client.navigate(next))
}
