import { createLogger } from "@alook/shared"
import type { NextRequest } from "next/server"
import { writeError } from "./helpers"

const log = createLogger({ service: "private-media-cache" })
const PRIVATE_NO_STORE = "private, no-store"

type MediaRouteHandler = (
  req: NextRequest,
  context?: { params?: Promise<Record<string, string>> | Record<string, string> },
) => Promise<Response>

export function withPrivateMediaCache(handler: MediaRouteHandler): MediaRouteHandler {
  return async (req, context) => {
    let response: Response
    try {
      response = await handler(req, context)
    } catch (error) {
      log.error("private_media_request_failed", {
        path: req.nextUrl.pathname,
        errorCategory: error instanceof Error ? error.name : "unknown",
      })
      return writeError("internal error", 500, { "Cache-Control": PRIVATE_NO_STORE })
    }

    if (!response.ok && response.status !== 304) {
      const result = new Response(response.body, response)
      result.headers.set("Cache-Control", PRIVATE_NO_STORE)
      return result
    }

    const directives = response.headers.get("Cache-Control")?.split(",") ?? []
    if (directives.some((directive) => directive.trim().toLowerCase() === "no-store")) return response

    const vary = response.headers.get("Vary")?.split(",").map((field) => field.trim()).filter(Boolean) ?? []
    if (vary.some((field) => field === "*")) return response
    const fields = vary.filter((field) => field.toLowerCase() !== "cookie")
    if (!fields.some((field) => field.toLowerCase() === "authorization")) fields.push("Authorization")
    const result = new Response(response.body, response)
    result.headers.set("Vary", fields.join(", "))
    return result
  }
}
