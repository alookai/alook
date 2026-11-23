import { finalizeCommunityDocumentResponse, finalizePublicWorkerResponse } from "./public-worker-response"

const PUBLIC_DOCUMENTS = new Set(["/", "/pricing", "/privacy", "/templates"])

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_DOCUMENTS.has(pathname) || /^\/templates\/[^/]+\/?$/.test(pathname)
}

export function createWebWorkerHandler(
  openNextHandler: ExportedHandler<CloudflareEnv>,
): ExportedHandler<CloudflareEnv> {
  return {
    async fetch(request, env, ctx) {
      request = new Request(request) as typeof request
      request.headers.delete("X-Alook-Internal")
      const url = new URL(request.url)
      const isWsUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket"
      const isWsPath = url.pathname === "/api/ws" || url.pathname.startsWith("/api/ws/")

      if (isWsUpgrade && isWsPath) {
        return env.WS_DO_WORKER.fetch(request)
      }

      const response = await openNextHandler.fetch!(request, env, ctx)
      return finalizeCommunityDocumentResponse(
        finalizePublicWorkerResponse(response, isPublicRoute(url.pathname), request),
        request,
      )
    },
  }
}
