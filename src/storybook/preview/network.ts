import { http, HttpResponse, passthrough } from "msw"
import { setupWorker } from "msw/browser"
import { readHandlers } from "./read-handlers"
import { communityJson, communityError } from "./community-response"

export const previewNetworkHandlers = [
  http.get("*/api/auth/get-session", () => HttpResponse.json(null)),
  http.get("*/api/community/invites/storybook-preview/info", () => communityJson({ serverId: "demo-studio", serverName: "Studio", serverIcon: null, serverDescription: "A local preview with people and agents.", memberCount: 3, memberPreview: [{ id: "demo-alli", avatar: "avatar:beam:demo-alli" }], inviter: { id: "demo-gus", name: "Gus", avatar: "/landing/people/lin.webp" } })),
  http.get("*/api/community/invites/storybook-expired/info", () => communityError("not_found", "This invitation has expired.", 410)),
  http.post("*/api/community/pages/storybook-page-revoked/viewer-token", () =>
    communityError("not_found", "This page was deleted or you no longer have access.", 404),
  ),
  http.post("*/api/community/pages/:id/viewer-token", ({ request }) => {
    const origin = new URL(request.url).origin
    return communityJson({
      embedUrl: `${origin}/preview/attachment.html`,
      allowedOrigins: [origin],
      expiresAt: "2026-11-27T14:00:00Z",
    })
  }),
  http.post("*/api/community/pages/:id/comments", () =>
    communityJson({ id: "storybook-comment-1", seq: 42 }),
  ),
  ...readHandlers,
  http.all("*", ({ request }) => {
    const path = new URL(request.url).pathname
    if (!path.startsWith("/api/")) return passthrough()
    console.error(`[Storybook fixture missing] ${request.method} ${path}`)
    const message = `No local fixture for ${request.method} ${path}`
    return path.startsWith("/api/community/") ? communityError("temporarily_unavailable", message, 501) : HttpResponse.json({ error: message }, { status: 501 })
  }),
]

export async function startPreviewNetwork() {
  const worker = setupWorker()
  await worker.start({ quiet: true, onUnhandledFrame: "bypass" })
  return worker
}
