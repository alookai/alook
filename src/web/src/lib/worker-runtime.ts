import { finalizePublicWorkerResponse } from "./public-worker-response"
import {
	NATIVE_OAUTH_ASSOCIATION_PATHS,
	NATIVE_OAUTH_RETURN_HOST,
	NATIVE_OAUTH_RETURN_PATH,
	nativeOauthSecurityHeaders,
} from "./native-oauth-host"

const PRIVATE_PREFIXES = ["/w/", "/workspaces", "/dashboard", "/invite/", "/api/", "/_next/"]

function isPublicRoute(pathname: string): boolean {
  return !PRIVATE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

const NATIVE_OAUTH_HOST_PATHS = new Set([
	...NATIVE_OAUTH_ASSOCIATION_PATHS,
	NATIVE_OAUTH_RETURN_PATH,
])

function nativeOauthHostNotFound(): Response {
	return new Response("Not Found", {
		status: 404,
		headers: {
			...nativeOauthSecurityHeaders,
			"Content-Type": "text/plain; charset=utf-8",
		},
	})
}

function secureNativeOauthHostResponse(response: Response): Response {
	const headers = new Headers(response.headers)
	for (const [name, value] of Object.entries(nativeOauthSecurityHeaders)) {
		headers.set(name, value)
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

export function createWebWorkerHandler(
  openNextHandler: ExportedHandler<CloudflareEnv>,
): ExportedHandler<CloudflareEnv> {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url)
      const isWsUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket"
      const isWsPath = url.pathname === "/api/ws" || url.pathname.startsWith("/api/ws/")
			const isNativeOauthHost =
				url.protocol === "https:" && url.host === NATIVE_OAUTH_RETURN_HOST
			const isNativeOauthHostPath = NATIVE_OAUTH_HOST_PATHS.has(url.pathname)

			if (isNativeOauthHost) {
				if (
					(request.method !== "GET" && request.method !== "HEAD") ||
					!isNativeOauthHostPath
				) {
					return nativeOauthHostNotFound()
				}
				const response = await openNextHandler.fetch!(request, env, ctx)
				return secureNativeOauthHostResponse(response)
			}

			if (isNativeOauthHostPath) return nativeOauthHostNotFound()

      if (isWsUpgrade && isWsPath) {
        return env.WS_DO_WORKER.fetch(request)
      }

			const response = await openNextHandler.fetch!(request, env, ctx)
			return finalizePublicWorkerResponse(response, isPublicRoute(url.pathname))
		},
	}
}
