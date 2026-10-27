import { describe, expect, it } from "vitest"
import { configuredLimits, effectiveLimits, settings } from "./config"
import { errorResponse, PageError } from "./contracts"
import { availablePrefix, hostPrefix, normalizePrefix } from "./prefix"
import { boundedBytes, parseUpload, sha256 } from "./upload"
import { config, manifest, operatorEnv, upload } from "../test-runtime/fixtures"

describe("names and operator configuration", () => {
  it("canonicalizes valid names without stripping invalid characters", () => {
    for (const value of ["A", "a-1", "x".repeat(63)]) expect(normalizePrefix(value)).toBe(value.toLowerCase())
    for (const value of ["", "-a", "a-", "a_b", "a.b", " a", "a ", "é", "x".repeat(64), "%61", "a\n"]) expect(() => normalizePrefix(value)).toThrow("invalid_prefix")
  })
  it("uses exact and starts-with filters independently", () => {
    const filters = settings({ ...operatorEnv, RESERVED_EXACT: " billing, Status ", RESERVED_PREFIXES: " ops-", SENSITIVE_EXACT: "adult", SENSITIVE_PREFIXES: "xxx-" })
    for (const value of ["WWW", "api", "admin", "auth", "mail", "alook", "alook-a", "internal-a", "billing", "status", "ops-a"]) expect(() => availablePrefix(value, filters)).toThrow("reserved_prefix")
    for (const value of ["adult", "xxx-a"]) expect(() => availablePrefix(value, filters)).toThrow("sensitive_prefix")
    for (const value of ["my-adult-site", "billinghelp", "xxx", "internal", "www2"]) expect(availablePrefix(value, filters)).toBe(value)
  })
  it.each([
    ["CF_ACCOUNT_ID", "bad"], ["CF_NAMESPACE", "a/b"], ["BASE_DOMAIN", "localhost"],
    ["PAGE_CPU_MS", "0"], ["PAGE_CPU_MS", "1e3"], ["PAGE_SUBREQUESTS", "1001"],
    ["UPLOAD_MAX_BYTES", "16777217"], ["FILE_MAX_BYTES", "8388609"], ["UPLOAD_MAX_FILES", "129"],
    ["CF_TIMEOUT_MS", "120001"], ["SENSITIVE_EXACT", "bad.name"],
  ])("fails closed for invalid %s", (key, value) => {
    expect(() => settings({ ...operatorEnv, [key]: value })).toThrow("invalid_operator_config")
  })
  it("lowers native limits and clamps old rows to a changed ceiling", () => {
    expect(configuredLimits({ cpuMs: 10, subRequests: 5 }, config.limits)).toEqual({ cpuMs: 10, subRequests: 5 })
    for (const value of [{ cpuMs: 1001, subRequests: 5 }, { cpuMs: 10, subRequests: 101 }, { cpuMs: 0, subRequests: 5 }, { cpuMs: 1.5, subRequests: 1 }, { cpuMs: 1, subRequests: 1, bindings: [] }]) expect(() => configuredLimits(value, config.limits)).toThrow("invalid_limits")
    expect(effectiveLimits({ cpuMs: 2000, subRequests: 3 }, config.limits)).toEqual({ cpuMs: 1000, subRequests: 3 })
  })
  it("accepts only one subdomain of the configured domain", () => {
    expect(hostPrefix(new URL("https://HELLO.alook.page/path"), config.domain)).toBe("hello")
    for (const value of ["https://alook.page/", "https://x.y.alook.page/", "https://x.alook.page.evil/", "https://x.alook.page:444/", "https://u:p@x.alook.page/", "https://x_alook.alook.page/"]) expect(() => hostPrefix(new URL(value), config.domain)).toThrow("unknown_host")
  })
  it("does not expose arbitrary error details", async () => {
    expect(await errorResponse(new Error("credential secret")).json()).toEqual({ error: "internal_error" })
    expect(errorResponse(new PageError("invalid_prefix", 409)).status).toBe(409)
  })
})

describe("bounded uploads", () => {
  it("hashes uploaded bytes and differentiates manifest configuration", async () => {
    const one = await parseUpload(upload(), config)
    expect(one.files[0].hash).toBe(await sha256(new TextEncoder().encode("<h1>Hello</h1>")))
    const two = await parseUpload(upload({ ...manifest("hello"), variables: { COLOR: "red" } }), config)
    expect(two.digest).not.toBe(one.digest)
    expect(one.digest).toHaveLength(64)
  })
  it("separates native MIME identity while retaining full content hashes", async () => {
    const files = [
      { part: "html", path: "/same.html", role: "asset", type: "text/html" },
      { part: "text", path: "/same.txt", role: "asset", type: "text/plain" },
      { part: "copy", path: "/copy.txt", role: "asset", type: "TEXT/PLAIN" },
    ]
    const value = await parseUpload(upload({ ...manifest(), files }, Object.fromEntries(files.map(file => [file.part, new Blob(["same bytes"])]))), config)
    const assets = value.files.filter(file => file.role === "asset")
    expect(new Set(assets.map(file => file.hash)).size).toBe(1)
    expect(assets[0].assetHash).not.toBe(assets[1].assetHash)
    expect(assets[1].assetHash).toBe(assets[2].assetHash)
    expect(assets[2].type).toBe("text/plain")
    expect(assets.every(file => /^[a-f0-9]{32}$/.test(file.assetHash))).toBe(true)
  })
  it("counts actual streaming bytes and cancels on overflow", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(6)) }, cancel() { cancelled = true } })
    await expect(boundedBytes(stream, 10)).rejects.toThrow("body_too_large")
    expect(cancelled).toBe(true)
    await expect(boundedBytes(null, 10)).rejects.toThrow("missing_body")
    const exact = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close() } })
    expect([...await boundedBytes(exact, 2)]).toEqual([1, 2])
  })
  it("does not trust the content-length header", async () => {
    const original = upload()
    const headers = new Headers(original.headers)
    headers.set("content-length", "1")
    const request = new Request(original.url, { method: "POST", headers, body: await original.arrayBuffer() })
    await expect(parseUpload(request, { ...config, uploadBytes: 10 })).rejects.toThrow("body_too_large")
  })
  it.each([
    ["/../x", "asset"], ["/a//b", "asset"], ["/a%2fb", "asset"], ["/a?b", "asset"],
    ["/a#b", "asset"], ["/a\\b", "asset"], ["relative", "asset"], ["/root.js", "module"],
    ["a/../x", "module"], ["metadata", "module"],
  ])("rejects malformed mapping %s", async (path, role) => {
    const value = manifest()
    value.files[0] = { ...value.files[0], path, role: role as "asset" | "module" }
    await expect(parseUpload(upload(value), config)).rejects.toThrow("invalid_file_mapping")
  })
  it("rejects duplicate, extra, missing, textual and oversized parts", async () => {
    await expect(parseUpload(upload(manifest(), {}), config)).rejects.toThrow("invalid_part_count")
    await expect(parseUpload(upload(manifest(), { index: "text" }), config)).rejects.toThrow("invalid_file_part")
    await expect(parseUpload(upload(manifest(), { index: new Blob(["x"]), extra: new Blob(["x"]) }), config)).rejects.toThrow("invalid_part_count")
    await expect(parseUpload(upload(), { ...config, fileBytes: 2 })).rejects.toThrow("file_too_large")
    await expect(parseUpload(upload(), { ...config, fileCount: 0 })).rejects.toThrow("invalid_part_count")
    const value = manifest()
    value.files.push({ ...value.files[0] })
    await expect(parseUpload(upload(value), config)).rejects.toThrow("invalid_file_mapping")
    value.files[1] = { ...value.files[1], part: "second" }
    await expect(parseUpload(upload(value), config)).rejects.toThrow("invalid_file_mapping")
    const duplicate = new FormData()
    duplicate.append("manifest", JSON.stringify(manifest()))
    duplicate.append("index", new Blob(["a"]))
    duplicate.append("index", new Blob(["b"]))
    await expect(parseUpload(new Request("https://private/", { method: "POST", body: duplicate }), config)).rejects.toThrow("invalid_part_count")
  })
  it("rejects malformed transport and strict manifests", async () => {
    await expect(parseUpload(new Request("https://private/", { method: "POST" }), config)).rejects.toThrow("multipart_required")
    await expect(parseUpload(new Request("https://private/", { method: "POST", body: "{}" }), config)).rejects.toThrow("multipart_required")
    await expect(parseUpload(new Request("https://private/", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: "bad" }), config)).rejects.toThrow("invalid_multipart")
    for (const raw of ["{", JSON.stringify({ ...manifest(), bindings: [] }), "x".repeat(65537)]) {
      const form = new FormData(); form.append("manifest", raw)
      await expect(parseUpload(new Request("https://private/", { method: "POST", body: form }), config)).rejects.toThrow("invalid_manifest")
    }
    const form = new FormData(); form.append("manifest", new Blob(["{}"]))
    await expect(parseUpload(new Request("https://private/", { method: "POST", body: form }), config)).rejects.toThrow("invalid_manifest")
  })
  it("rejects application binding and module/configuration mismatches", async () => {
    for (const variables of [{ REGISTRY: "x" }, { ASSETS: "x" }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, "x"]))]) await expect(parseUpload(upload({ ...manifest(), variables }), config)).rejects.toThrow("invalid_variables")
    await expect(parseUpload(upload({ ...manifest(), compatibilityFlags: ["nodejs_compat", "nodejs_compat"] }), config)).rejects.toThrow("invalid_compatibility_flags")
    await expect(parseUpload(upload({ ...manifest(), files: [{ ...manifest().files[0], type: "bad mime" }] }), config)).rejects.toThrow("invalid_asset_type")
    const mod = { role: "module", part: "code", path: "main.js", type: "application/javascript+module" }
    await expect(parseUpload(upload({ ...manifest(), files: [mod] }, { code: new Blob(["export default{};"]) }), config)).rejects.toThrow("missing_entry")
    await expect(parseUpload(upload({ ...manifest(), files: [{ ...mod, type: "text/typescript" }] }, { code: new Blob(["x"]) }), config)).rejects.toThrow("unsupported_module_type")
    await expect(parseUpload(upload({ ...manifest(), files: [mod], assets: {}, entry: { path: "main.js", format: "module" } }, { code: new Blob(["x"]) }), config)).rejects.toThrow("assets_config_without_assets")
    await expect(parseUpload(upload({ ...manifest(), files: [mod], entry: { path: "other.js", format: "module" } }, { code: new Blob(["x"]) }), config)).rejects.toThrow("invalid_entry")
    const classic = { ...mod, type: "application/javascript" }
    await expect(parseUpload(upload({ ...manifest(), entry: { path: "main.js", format: "classic" }, files: [classic, manifest().files[0]] }, { code: new Blob(["x"]), index: new Blob(["x"]) }), config)).rejects.toThrow("unsupported_classic_combination")
    const requirement = { ...mod, part: "req", path: "numpy", type: "text/x-python-requirement" }
    await expect(parseUpload(upload({ ...manifest(), entry: { path: "main.js", format: "module" }, files: [mod, requirement] }, { code: new Blob(["x"]), req: new Blob([]) }), config)).rejects.toThrow("invalid_python_combination")
  })
  it.each(["module", "classic", "python"] as const)("accepts a native %s entry", async format => {
    const type = { module: "application/javascript+module", classic: "application/javascript", python: "text/x-python" }[format]
    const value = { ...manifest(), files: [{ role: "module", part: "code", path: "main", type }], entry: { path: "main", format } }
    expect((await parseUpload(upload(value, { code: new Blob(["native artifact"]) }), config)).manifest.entry?.format).toBe(format)
  })
  it("preserves caller-built Wasm/text/binary/source-map and Python requirement modules", async () => {
    const entry = { role: "module", part: "code", path: "main.py", type: "text/x-python" }
    const helpers = ["text/x-python-requirement", "application/wasm", "text/plain", "application/octet-stream", "application/source-map"].map((type, i) => ({ role: "module", part: `helper${i}`, path: `helper${i}`, type }))
    const parts = Object.fromEntries([entry, ...helpers].map(file => [file.part, new Blob([file.type])]))
    const value = await parseUpload(upload({ ...manifest(), entry: { path: "main.py", format: "python" }, files: [entry, ...helpers] }, parts), config)
    expect(value.files.map(file => file.type)).toEqual([entry, ...helpers].map(file => file.type))
  })
})
