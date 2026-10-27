import { z } from "zod"
import type { Settings } from "./config"
import { PageError, type Artifact, type Release } from "./contracts"
import { boundedBytes } from "./upload"

export interface NativeScript {
  tags: string[]
}
export interface Provider {
  inspect(target: string): Promise<NativeScript | null>
  assets(target: string, artifact: Artifact): Promise<string | undefined>
  publish(target: string, artifact: Artifact, release: Release, pageId: string, assetJwt?: string): Promise<void>
  destroy(target: string): Promise<void>
}
export class ProviderError extends PageError {
  constructor(code: string, readonly uncertain: boolean) { super(code, 502) }
}

const envelope = z.object({ success: z.literal(true), result: z.unknown() })
const scriptResult = z.object({ script: z.object({ tags: z.array(z.string()).default([]) }) })
const assetSession = z.object({ jwt: z.string().min(1).max(16_384), buckets: z.array(z.array(z.string().regex(/^[a-f0-9]{32}$/)).min(1).max(128)).max(128) })
const uploadResult = z.object({ jwt: z.string().min(1).max(16_384).optional() })
const publishResult = z.object({ id: z.string().optional(), etag: z.string().optional() })

export function ownership(pageId: string, release: Release): string[] {
  return [`alook-page:${pageId}`, `alook-operation:${release.operationId}`, `alook-artifact:${release.digest}`]
}

export function owns(script: NativeScript, pageId: string, release: Release): boolean {
  return ownership(pageId, release).every(tag => script.tags.includes(tag))
}

export class CloudflareProvider implements Provider {
  private readonly base: string
  constructor(private readonly config: Settings, private readonly token: string, private readonly request: typeof fetch = fetch) {
    this.base = `https://api.cloudflare.com/client/v4/accounts/${config.account}`
  }

  private scriptPath(target: string): string {
    return `/workers/dispatch/namespaces/${this.config.namespace}/scripts/${target}`
  }

  private async call(path: string, method: string, body?: BodyInit, token = this.token, contentType?: string): Promise<Response> {
    if (!token) throw new ProviderError("missing_provider_secret", false)
    const headers = new Headers({ authorization: `Bearer ${token}` })
    if (contentType) headers.set("content-type", contentType)
    try {
      return await this.request(`${this.base}${path}`, {
        method, headers, body, redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch {
      throw new ProviderError("provider_transport_error", method !== "GET")
    }
  }

  private async result(response: Response, write: boolean): Promise<unknown> {
    if (!response.ok) {
      await response.body?.cancel()
      throw new ProviderError(`provider_http_${response.status}`, write && (response.status >= 500 || response.status === 408 || response.status === 499))
    }
    try {
      const bytes = await boundedBytes(response.body, 65_536)
      const data: unknown = JSON.parse(new TextDecoder().decode(bytes))
      const parsed = envelope.safeParse(data)
      if (!parsed.success) throw new Error("invalid_envelope")
      return parsed.data.result
    } catch {
      throw new ProviderError("provider_invalid_response", write)
    }
  }

  async inspect(target: string): Promise<NativeScript | null> {
    const response = await this.call(this.scriptPath(target), "GET")
    if (response.status === 404) { await response.body?.cancel(); return null }
    const parsed = scriptResult.safeParse(await this.result(response, false))
    if (!parsed.success) throw new ProviderError("provider_invalid_metadata", false)
    return parsed.data.script
  }

  async assets(target: string, artifact: Artifact): Promise<string | undefined> {
    const files = artifact.files.filter(file => file.role === "asset")
    if (!files.length) return undefined
    const manifest = Object.fromEntries(files.map(file => [file.path, { hash: file.assetHash, size: file.blob.size }]))
    const response = await this.call(`${this.scriptPath(target)}/assets-upload-session`, "POST", JSON.stringify({ manifest }), this.token, "application/json")
    const parsed = assetSession.safeParse(await this.result(response, true))
    if (!parsed.success) throw new ProviderError("provider_invalid_asset_session", true)
    const session = parsed.data
    const byHash = new Map(files.map(file => [file.assetHash, file]))
    const requested = session.buckets.flat()
    if (new Set(requested).size !== requested.length || requested.some(hash => !byHash.has(hash))) throw new ProviderError("provider_invalid_asset_groups", true)
    if (!requested.length) return session.jwt
    let complete: string | undefined
    for (const bucket of session.buckets) {
      const form = new FormData()
      for (const hash of bucket) {
        const file = byHash.get(hash)!
        const bytes = new Uint8Array(await file.blob.arrayBuffer())
        let encoded = ""
        for (let offset = 0; offset < bytes.length; offset += 32_768) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
        form.append(hash, new Blob([btoa(encoded)], { type: file.type }), hash)
      }
      const uploaded = await this.call("/workers/assets/upload?base64=true", "POST", form, session.jwt)
      const status = uploaded.status
      const result = uploadResult.safeParse(await this.result(uploaded, true))
      if (!result.success) throw new ProviderError("provider_invalid_asset_completion", true)
      if (status === 201 && result.data.jwt) complete = result.data.jwt
    }
    if (!complete) throw new ProviderError("provider_incomplete_asset_upload", true)
    return complete
  }

  async publish(target: string, artifact: Artifact, release: Release, pageId: string, assetJwt?: string): Promise<void> {
    const manifest = artifact.manifest
    const form = new FormData()
    const entry = manifest.entry ?? { format: "module", path: "__alook_static__.mjs" }
    const bindings: Array<{ type: "plain_text"; name: string; text: string } | { type: "assets"; name: string }> = Object.entries(manifest.variables)
      .map(([name, text]) => ({ type: "plain_text", name, text }))
    if (assetJwt) bindings.push({ type: "assets", name: "ASSETS" })
    const flags = [...manifest.compatibilityFlags]
    if (entry.format === "python" && !flags.includes("python_workers")) flags.push("python_workers")
    const metadata = {
      ...(entry.format === "classic" ? { body_part: entry.path } : { main_module: entry.path }),
      compatibility_date: manifest.compatibilityDate,
      compatibility_flags: flags,
      bindings,
      tags: ownership(pageId, release),
      ...(assetJwt ? { assets: { jwt: assetJwt, config: manifest.assets ?? {} } } : {}),
    }
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }))
    for (const file of artifact.files.filter(file => file.role === "module")) form.append(file.path, file.blob.slice(0, file.blob.size, file.type), file.path)
    if (!manifest.entry) form.append(entry.path, new Blob(["export default { fetch(request, env) { return env.ASSETS.fetch(request) } }"], { type: "application/javascript+module" }), entry.path)
    const response = await this.call(this.scriptPath(target), "PUT", form)
    if (!publishResult.safeParse(await this.result(response, true)).success) throw new ProviderError("provider_invalid_publication", true)
  }

  async destroy(target: string): Promise<void> {
    const response = await this.call(this.scriptPath(target), "DELETE")
    if (response.ok || response.status === 404) { await response.body?.cancel(); return }
    await this.result(response, true)
  }
}
