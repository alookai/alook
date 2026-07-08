import type { Logger } from "@alook/shared"

interface FetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>
}

/**
 * Service-binding-first, dev-HTTP-fallback fetch. Extracted from
 * `broadcast.ts`'s original `wsDoFetch` (that's still the canonical
 * caller/behavior spec — see its tests) because `wake-transport.ts` needs
 * the EXACT same shape of fallback for `WAKE_WORKER`: `next dev`'s
 * `getPlatformProxy` service bindings to separately-run `wrangler dev`
 * workers are not reliably reachable, so every cross-worker call from
 * `src/web` needs "try the real binding, fall back to a plain HTTP URL at
 * the worker's `[dev] port`" — never duplicate this decision tree per
 * binding.
 *
 * Falls back to `fallbackBaseUrl` when the binding is absent, throws, or
 * returns a 5xx. Never falls back on a 4xx (client error — the caller's
 * request was bad, retrying via HTTP won't help, and would just hide the
 * real error behind a second, unrelated one).
 */
export async function fetchViaBindingOrDevFallback(
  binding: FetcherLike | undefined,
  fallbackBaseUrl: string,
  path: string,
  init: RequestInit,
  opts: { logPrefix: string; log: Logger; label?: string; type?: string },
): Promise<Response> {
  const { logPrefix, log, label, type } = opts
  let bindingAttempted = false

  if (binding) {
    bindingAttempted = true
    try {
      const res = await binding.fetch(`http://internal${path}`, init)
      if (res.ok) return res
      if (res.status >= 400 && res.status < 500) {
        log.warn(`${logPrefix} service-binding non-ok (client-error)`, { label, type, path, status: res.status })
        return res
      }
      log.warn(`${logPrefix} service-binding non-ok`, { label, type, path, status: res.status })
    } catch (err) {
      log.warn(`${logPrefix} service-binding threw, falling back`, { label, type, path, err: String(err) })
    }
  }

  try {
    const res = await fetch(`${fallbackBaseUrl}${path}`, init)
    if (!res.ok) {
      log.error(`${logPrefix} HTTP fallback non-ok`, { label, type, path, status: res.status, url: fallbackBaseUrl })
    } else if (bindingAttempted) {
      log.info(`${logPrefix} HTTP fallback recovered`, { label, type, path })
    }
    return res
  } catch (err) {
    log.error(`${logPrefix} HTTP fallback threw`, { label, type, path, url: fallbackBaseUrl, err: String(err) })
    throw err
  }
}
