import openNextHandler from "#open-next-worker"
import { createWebWorkerHandler } from "./src/lib/worker-runtime"

export { DOQueueHandler } from "#open-next-worker"

const webHandler = createWebWorkerHandler(openNextHandler)
export default {
  ...webHandler,
  async scheduled(_event: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    const request = new Request("https://internal/api/internal/account-maintenance", {
      method: "POST", headers: { "X-Alook-Internal": "1" },
    })
    const response = await openNextHandler.fetch(request, env, ctx)
    if (!response.ok) throw new Error(`Account maintenance failed: ${response.status}`)
  },
} satisfies ExportedHandler<CloudflareEnv>
