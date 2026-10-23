import type { Page, Request, Route } from "@playwright/test"
import type { CaseResources } from "./case-fixture"

export async function holdRoute(page: Page, pattern: string | ((url: URL) => boolean), resources: CaseResources) {
  let releaseGate!: () => void
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  const pending = new Set<Request>()
  const continuations: Promise<void>[] = []
  let held = 0
  const settle = (request: Request) => { pending.delete(request) }
  page.on("requestfinished", settle)
  page.on("requestfailed", settle)
  const handler = (route: Route) => {
    const request = route.request()
    pending.add(request)
    held += 1
    const continuation = (async () => {
      await gate
      if (!pending.has(request)) return
      try { await route.continue() } catch (error) {
        if (pending.has(request)) throw error
      }
    })()
    continuations.push(continuation)
    return continuation
  }
  await page.route(pattern, handler)
  let closed = false
  const release = async () => {
    if (closed) return
    closed = true
    releaseGate()
    await Promise.all(continuations)
    await page.unroute(pattern, handler)
    page.off("requestfinished", settle)
    page.off("requestfailed", settle)
  }
  resources.own(release, async captured => { await captured() })
  return { held: () => held, release }
}
