import { DurableObject } from "cloudflare:workers"
import { createWebWorkerHandler } from "../src/lib/worker-runtime"

export class DOQueueHandler extends DurableObject<CloudflareEnv> {}

const openNextHandler: ExportedHandler<CloudflareEnv> = {
  async fetch(request) {
    const url = new URL(request.url)
    return new Response(`open-next:${url.pathname}`, {
      headers: { "x-open-next": "test-entry" },
    })
  },
}

export default createWebWorkerHandler(openNextHandler)
