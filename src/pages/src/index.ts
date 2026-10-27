import { WorkerEntrypoint } from "cloudflare:workers"
import { CloudflareProvider } from "./cloudflare"
import { effectiveLimits, settings } from "./config"
import { errorResponse } from "./contracts"
import { dispatch } from "./dispatch"
import { Registry } from "./registry"
import { PageService } from "./service"
import { parseUpload } from "./upload"

export class PageManager extends WorkerEntrypoint<Env> {
  #service() {
    const config = settings(this.env)
    return new PageService(new Registry(this.env.REGISTRY, config.namespace, config.account), new CloudflareProvider(config, this.env.PAGES_API_TOKEN), config,
      async (target, prefix, limits) => {
        const worker = this.env.DISPATCHER.get(target, {}, { limits: effectiveLimits(limits, config.limits) })
        const response = await worker.fetch(new Request(`https://${prefix}.${config.domain}/__alook_publication_probe`, { signal: AbortSignal.timeout(config.timeoutMs) }))
        await response.body?.cancel()
      })
  }

  async #respond(action: () => Promise<unknown>): Promise<Response> {
    try { return Response.json(await action(), { headers: { "cache-control": "no-store" } }) } catch (error) { return errorResponse(error) }
  }

  create(request: Request) { return this.#respond(async () => this.#service().create(await parseUpload(request, settings(this.env)))) }
  get(id: string) { return this.#respond(() => this.#service().get(id)) }
  update(id: string, request: Request) { return this.#respond(async () => this.#service().update(id, await parseUpload(request, settings(this.env)))) }
  destroy(id: string) { return this.#respond(() => this.#service().destroy(id)) }
  configure(id: string, limits: unknown) { return this.#respond(() => this.#service().configure(id, limits)) }
  recover(id: string) { return this.#respond(() => this.#service().recover(id)) }
}

export default { fetch: dispatch } satisfies ExportedHandler<Env>
