import { DurableObject } from "cloudflare:workers"

export class DOQueueHandler extends DurableObject<CloudflareEnv> {}

const openNextHandler: ExportedHandler<CloudflareEnv> = {
  async fetch(request) {
    const url = new URL(request.url)
    return new Response(`open-next:${url.pathname}`, {
      status: url.pathname === "/missing" ? 404 : 200,
      headers: { "x-open-next": "test-entry" },
    })
  },
}

export default openNextHandler
