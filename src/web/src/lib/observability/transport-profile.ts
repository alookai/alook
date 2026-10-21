export function resolveTransportProfile(mode: string | undefined, localEndpoint: string | undefined, collector: string | undefined) {
  if (mode === "development" && localEndpoint) {
    try {
      const url = new URL(localEndpoint)
      if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.port && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash) {
        return { kind: "otlp" as const, urls: [url.origin + "/v1/traces", url.origin + "/v1/logs"] }
      }
    } catch {}
    return undefined
  }
  try {
    const url = new URL(collector ?? "")
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) return { kind: "faro" as const, urls: [collector!] }
  } catch {}
  return undefined
}
