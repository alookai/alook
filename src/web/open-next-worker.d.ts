import type { OpenNextWorkerHandler } from "./open-next-handler"
export { DOQueueHandler } from "@opennextjs/cloudflare/durable-objects/queue"
declare const handler: OpenNextWorkerHandler<CloudflareEnv>
export default handler
