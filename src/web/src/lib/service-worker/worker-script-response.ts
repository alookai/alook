import type { SerwistPlugin } from "serwist"
import { isPublicAssetRequest, isPublicAssetResponse } from "./public-cache"

export function createPublicWorkerScriptResponsePlugin(origin: string): SerwistPlugin {
  return {
    handlerWillRespond: async ({ request, response }) => {
      if (request.destination !== "worker" && request.destination !== "sharedworker") return response
      if (!response.url || !isPublicAssetRequest(request, origin) || !isPublicAssetResponse(request, response)) return response
      const requestUrl = new URL(request.url)
      const responseUrl = new URL(response.url)
      if (!/\.m?js$/.test(requestUrl.pathname) || responseUrl.origin !== origin || responseUrl.pathname !== requestUrl.pathname) return response
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers })
    },
  }
}
