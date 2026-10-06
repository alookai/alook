import { finalizePublicWorkerResponse } from "./public-worker-response"

const PRIVATE_PREFIXES = ["/w/", "/workspaces", "/dashboard", "/invite/", "/api/", "/_next/"]

function isPublicRoute(pathname: string): boolean {
  return !PRIVATE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

export function createWebWorkerHandler(
  openNextHandler: ExportedHandler<CloudflareEnv>,
): ExportedHandler<CloudflareEnv> {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url)
      const isWsUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket"
      const isWsPath = url.pathname === "/api/ws" || url.pathname.startsWith("/api/ws/")

      if (isWsUpgrade && isWsPath) {
        return env.WS_DO_WORKER.fetch(request)
      }

			const response = await openNextHandler.fetch!(request, env, ctx)
			return finalizePublicWorkerResponse(response, isPublicRoute(url.pathname))
		},
	}
}
