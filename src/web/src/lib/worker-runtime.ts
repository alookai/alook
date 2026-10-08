import { cleanAttributes } from "./observability/schema"
import { routeTemplate } from "./observability/coverage"
import { workerRequestAttributes } from "./observability/worker"
import { resolveObservationBuild } from "./observability/build"
import { finalizePublicWorkerResponse } from "./public-worker-response"

const PUBLIC_DOCUMENTS = new Set(["/", "/pricing", "/privacy", "/templates"])

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_DOCUMENTS.has(pathname) || /^\/templates\/[^/]+\/?$/.test(pathname)
}

export function createWebWorkerHandler(
  openNextHandler: ExportedHandler<CloudflareEnv>,
  build = resolveObservationBuild({}),
): ExportedHandler<CloudflareEnv> {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url)
      const isWsUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket"
      const isWsPath = url.pathname === "/api/ws" || url.pathname.startsWith("/api/ws/")

      if (isWsUpgrade && isWsPath) {
        return env.WS_DO_WORKER.fetch(request)
      }

			const execute = async () => {
				const response = await openNextHandler.fetch!(request, env, ctx)
				return finalizePublicWorkerResponse(response, isPublicRoute(url.pathname), request)
			}
			return ctx.tracing ? ctx.tracing.enterSpan("web.request", span => {
				const fields = cleanAttributes({ ...workerRequestAttributes(request, env, build), route_template: routeTemplate(request.url, url.origin), request_kind: url.searchParams.has("_rsc") ? "rsc" : url.pathname.startsWith("/api/") ? "api" : "document" })
				for (const [key, value] of Object.entries(fields)) span.setAttribute(key, value)
				return execute()
			}) : execute()
		},
	}
}
