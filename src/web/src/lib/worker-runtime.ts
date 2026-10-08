import { cleanAttributes, type Attributes } from "./observability/schema"
import { routeTemplate } from "./observability/coverage"
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

export function workerRequestAttributes(request: Request, env: Pick<Env, "CF_VERSION_METADATA">, build: ReturnType<typeof resolveObservationBuild>): Attributes {
  const parent = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(request.headers.get("traceparent") ?? "")
  const valid = parent && !/^0+$/.test(parent[1]!) && !/^0+$/.test(parent[2]!)
  return { ...build,
    worker_version: env.CF_VERSION_METADATA?.id, worker_version_status: env.CF_VERSION_METADATA?.id ? "present" : "missing",
    upstream_trace_id: valid ? parent[1] : undefined, upstream_span_id: valid ? parent[2] : undefined,
    trace_context: valid ? "received" : "missing" }
}
