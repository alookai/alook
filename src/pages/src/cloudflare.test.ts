import { describe, expect, it, vi } from "vitest"
import { CloudflareProvider, ownership, owns, ProviderError } from "./cloudflare"
import { parseUpload } from "./upload"
import { artifact, config, manifest, upload } from "../test-runtime/fixtures"

const ok = (result: unknown, status = 200) => Response.json({ success: true, result }, { status })
const release = { target: "p-owned-1", operationId: "op", digest: "d".repeat(64) }

describe("native platform adapter", () => {
  it("reads the native nested script metadata and treats only404 as absent", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(ok({ script: { tags: ownership("page", release) } }))
      .mockResolvedValueOnce(ok({ script: {} })).mockResolvedValueOnce(new Response(null, { status: 404 }))
    const provider = new CloudflareProvider(config, "account-secret", request)
    expect(owns((await provider.inspect(release.target))!, "page", release)).toBe(true)
    expect(owns({ tags: ["other"] }, "page", release)).toBe(false)
    expect(await provider.inspect(release.target)).toEqual({ tags: [] })
    expect(await provider.inspect(release.target)).toBeNull()
    expect(request.mock.calls[0][0]).toBe(`https://api.cloudflare.com/client/v4/accounts/${config.account}/workers/dispatch/namespaces/test/scripts/p-owned-1`)
    expect(new Headers(request.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer account-secret")
  })
  it("rejects malformed and oversized native metadata without exposing the body", async () => {
    for (const response of [ok({ tags: [] }), ok(null), Response.json({ success: false, errors: [{ secret: "do-not-copy" }] }), new Response("bad"), new Response(null), new Response("s".repeat(65537))]) {
      const provider = new CloudflareProvider(config, "token", vi.fn<typeof fetch>().mockResolvedValue(response))
      await expect(provider.inspect("x")).rejects.toBeInstanceOf(ProviderError)
    }
    for (const status of [401, 429, 500]) {
      const provider = new CloudflareProvider(config, "token", vi.fn<typeof fetch>().mockResolvedValue(new Response("private", { status })))
      await expect(provider.inspect("x")).rejects.toMatchObject({ code: `provider_http_${status}`, uncertain: false })
    }
  })
  it("does not retry writes, marks transport/server/invalid success as uncertain", async () => {
    const value = await artifact()
    for (const [response, uncertain] of [[new Response("private", { status: 400 }), false], [new Response("private", { status: 408 }), true], [new Response("private", { status: 499 }), true], [new Response("private", { status: 503 }), true], [ok({}), false]] as const) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(response)
      const promise = new CloudflareProvider(config, "token", request).publish("x", value, release, "page")
      if (response.ok) await promise
      else await expect(promise).rejects.toMatchObject({ uncertain })
      expect(request).toHaveBeenCalledTimes(1)
      expect(request.mock.calls[0][1]?.redirect).toBe("error")
      expect(request.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    }
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret network detail"))
    const provider = new CloudflareProvider(config, "token", request)
    await expect(provider.publish("x", value, release, "page")).rejects.toMatchObject({ code: "provider_transport_error", uncertain: true })
    await expect(provider.inspect("x")).rejects.toMatchObject({ uncertain: false })
    await expect(new CloudflareProvider(config, "", request).inspect("x")).rejects.toMatchObject({ code: "missing_provider_secret", uncertain: false })
    await expect(new CloudflareProvider(config, "token", vi.fn<typeof fetch>().mockResolvedValue(new Response("bad"))).publish("x", value, release, "page")).rejects.toMatchObject({ code: "provider_invalid_response", uncertain: true })
    await expect(new CloudflareProvider(config, "token", vi.fn<typeof fetch>().mockResolvedValue(ok(null))).publish("x", value, release, "page")).rejects.toMatchObject({ code: "provider_invalid_publication", uncertain: true })
  })
  it("uploads native missing-hash groups with session JWT and publishes completion JWT", async () => {
    const value = await parseUpload(upload({ ...manifest(), files: [
      ...manifest().files,
      { role: "asset", part: "binary", path: "/image.bin", type: "application/octet-stream" },
    ] }, { index: new Blob(["<h1>Hello</h1>"]), binary: new Blob([new Uint8Array([0, 127, 128, 255])]) }), config)
    const hashes = value.files.filter(file => file.role === "asset").map(file => file.assetHash)
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ jwt: "session-jwt", buckets: [[hashes[0]], [hashes[1]]] }))
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(ok({ jwt: "complete-jwt" }, 201))
      .mockResolvedValueOnce(ok({ id: "native-script" }))
    const provider = new CloudflareProvider(config, "account-secret", request)
    const jwt = await provider.assets(release.target, value)
    expect(jwt).toBe("complete-jwt")
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ manifest: Object.fromEntries(value.files.filter(file => file.role === "asset").map(file => [file.path, { hash: file.assetHash, size: file.blob.size }])) })
    for (const index of [1, 2]) {
      const [, init] = request.mock.calls[index]
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer session-jwt")
      const form = init?.body
      expect(form).toBeInstanceOf(FormData)
      if (!(form instanceof FormData)) throw new Error("expected multipart")
      const file = form.get(hashes[index - 1])
      if (!(file instanceof Blob)) throw new Error("expected file")
      expect(atob(await file.text())).toBe(String.fromCharCode(...new Uint8Array(await value.files[index - 1].blob.arrayBuffer())))
      expect(file.type).toBe(value.files[index - 1].type)
    }
    await provider.publish(release.target, value, release, "page", jwt)
    const form = request.mock.calls[3][1]?.body
    if (!(form instanceof FormData)) throw new Error("expected multipart")
    const metadata = form.get("metadata")
    if (!(metadata instanceof Blob)) throw new Error("expected metadata")
    const native = JSON.parse(await metadata.text())
    expect(native).toMatchObject({ main_module: "__alook_static__.mjs", bindings: [{ type: "assets", name: "ASSETS" }], assets: { jwt: "complete-jwt", config: {} }, tags: ownership("page", release) })
    expect(form.has("__alook_static__.mjs")).toBe(true)
    expect(form.has("/index.html")).toBe(false)
    expect(JSON.stringify(native)).not.toContain("account-secret")
  })
  it("uses a no-missing-files session token without another upload", async () => {
    const value = await artifact()
    const request = vi.fn<typeof fetch>().mockResolvedValue(ok({ jwt: "already-present", buckets: [] }))
    expect(await new CloudflareProvider(config, "token", request).assets("x", value)).toBe("already-present")
    expect(request).toHaveBeenCalledTimes(1)
  })
  it("uploads distinct MIME parts for identical bytes in one native manifest", async () => {
    const files = [
      { part: "html", path: "/same.html", role: "asset", type: "text/html" },
      { part: "text", path: "/same.txt", role: "asset", type: "text/plain" },
      { part: "copy", path: "/copy.txt", role: "asset", type: "TEXT/PLAIN" },
    ]
    const value = await parseUpload(upload({ ...manifest(), files }, Object.fromEntries(files.map(file => [file.part, new Blob(["same bytes"])]))), config)
    const assets = value.files.filter(file => file.role === "asset")
    const keys = [...new Set(assets.map(file => file.assetHash))]
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(ok({ jwt: "session", buckets: [keys] })).mockResolvedValueOnce(ok({ jwt: "complete" }, 201))
    expect(await new CloudflareProvider(config, "token", request).assets("x", value)).toBe("complete")
    const form = request.mock.calls[1][1]?.body
    if (!(form instanceof FormData)) throw new Error("expected multipart")
    expect([...form.keys()]).toEqual(keys)
    for (const [index, type] of ["text/html", "text/plain"].entries()) {
      const file = form.get(keys[index])
      if (!(file instanceof Blob)) throw new Error("expected asset")
      expect(file.type).toBe(type)
      expect(atob(await file.text())).toBe("same bytes")
    }
    const sent = JSON.parse(String(request.mock.calls[0][1]?.body))
    expect(sent.manifest["/same.txt"].hash).toBe(sent.manifest["/copy.txt"].hash)
    expect(sent.manifest["/same.html"].hash).not.toBe(sent.manifest["/same.txt"].hash)
  })
  it("requests new bytes after a MIME-only change instead of reusing cached native headers", async () => {
    const html = await parseUpload(upload(manifest(), { index: new Blob(["unchanged bytes"]) }), config)
    const text = await parseUpload(upload({ ...manifest(), files: [{ ...manifest().files[0], type: "text/plain" }] }, { index: new Blob(["unchanged bytes"]) }), config)
    const cache = new Map<string, string>()
    const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith("/assets-upload-session")) {
        const data = JSON.parse(String(init?.body)) as { manifest: Record<string, { hash: string }> }
        const missing = Object.values(data.manifest).map(file => file.hash).filter(hash => !cache.has(hash))
        return ok({ jwt: missing.length ? "session" : "complete", buckets: missing.length ? [missing] : [] })
      }
      if (!(init?.body instanceof FormData)) throw new Error("expected multipart")
      for (const [hash, blob] of init.body.entries()) {
        if (!(blob instanceof Blob)) throw new Error("expected asset")
        cache.set(hash, blob.type)
      }
      return ok({ jwt: "complete" }, 201)
    })
    const provider = new CloudflareProvider(config, "token", request)
    await provider.assets("first", html)
    await provider.assets("second", text)
    await provider.assets("third", text)
    expect(cache.size).toBe(2)
    expect([...cache.values()]).toEqual(["text/html", "text/plain"])
    expect(request).toHaveBeenCalledTimes(5)
    expect(request.mock.calls.filter(([url]) => String(url).includes("/workers/assets/upload?"))).toHaveLength(2)
    expect(html.files[0].hash).toBe(text.files[0].hash)
  })
  it("rejects untrusted groups and missing completion tokens", async () => {
    const value = await artifact()
    const hash = value.files.filter(file => file.role === "asset")[0].assetHash
    for (const session of [{ jwt: "x", buckets: [["bad"]] }, { jwt: "x", buckets: [["f".repeat(32)]] }, { jwt: "x", buckets: [[hash], [hash]] }, { jwt: "x", buckets: [[], [hash]] }, { buckets: [] }]) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(ok(session))
      await expect(new CloudflareProvider(config, "token", request).assets("x", value)).rejects.toBeInstanceOf(ProviderError)
      expect(request).toHaveBeenCalledTimes(1)
    }
    for (const completion of [ok({}), ok({ jwt: "not201" }), ok({ jwt: 42 }, 201)]) {
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(ok({ jwt: "x", buckets: [[hash]] })).mockResolvedValueOnce(completion)
      await expect(new CloudflareProvider(config, "token", request).assets("x", value)).rejects.toBeInstanceOf(ProviderError)
    }
  })
  it.each(["module", "classic", "python"] as const)("builds native %s module metadata", async format => {
    const type = { module: "application/javascript+module", classic: "application/javascript", python: "text/x-python" }[format]
    const value = await parseUpload(upload({ ...manifest(), variables: { MESSAGE: "hello" }, entry: { path: "main", format }, files: [{ role: "module", part: "code", path: "main", type }] }, { code: new Blob(["code"]) }), config)
    const request = vi.fn<typeof fetch>().mockResolvedValue(ok({}))
    const provider = new CloudflareProvider(config, "token", request)
    expect(await provider.assets("x", value)).toBeUndefined()
    await provider.publish("x", value, release, "page")
    const form = request.mock.calls[0][1]?.body
    if (!(form instanceof FormData)) throw new Error("expected multipart")
    const metadata = form.get("metadata")
    if (!(metadata instanceof Blob)) throw new Error("expected metadata")
    const data = JSON.parse(await metadata.text())
    expect(data).toMatchObject({ [format === "classic" ? "body_part" : "main_module"]: "main", bindings: [{ type: "plain_text", name: "MESSAGE", text: "hello" }] })
    expect(data.compatibility_flags).toEqual(format === "python" ? ["python_workers"] : [])
    expect(data.assets).toBeUndefined()
    const code = form.get("main")
    expect(code instanceof Blob && code.type).toBe(type)
  })
  it("accepts204 and404 deletion without attempting JSON parsing", async () => {
    for (const status of [204, 404]) await expect(new CloudflareProvider(config, "token", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }))).destroy("x")).resolves.toBeUndefined()
    await expect(new CloudflareProvider(config, "token", vi.fn<typeof fetch>().mockResolvedValue(new Response("private", { status: 500 }))).destroy("x")).rejects.toMatchObject({ code: "provider_http_500", uncertain: true })
  })
})
