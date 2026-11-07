import { http, HttpResponse, passthrough } from "msw"
import { setupWorker } from "msw/browser"
import { readHandlers } from "./read-handlers"
import { communityJson, communityError } from "./community-response"

export const previewNetworkHandlers = [
  http.get("*/api/auth/get-session", () => HttpResponse.json(null)),
  http.get("*/api/community/invites/storybook-preview/info", () => communityJson({ serverId: "demo-studio", serverName: "Studio", serverIcon: null, serverDescription: "A local preview with people and agents.", memberCount: 3, memberPreview: [{ id: "demo-alli", avatar: "avatar:beam:demo-alli" }], inviter: { id: "demo-gus", name: "Gus", avatar: "/landing/people/lin.webp" } })),
  http.get("*/api/community/invites/storybook-expired/info", () => communityError("not_found", "This invitation has expired.", 410)),
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
