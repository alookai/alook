import type { Settings } from "./config"
import { manifestSchema, moduleTypes, PageError, type Artifact, type Manifest, type UploadFile } from "./contracts"

export async function boundedBytes(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) throw new PageError("missing_body")
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new PageError("body_too_large", 413)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function validPath(path: string, asset: boolean): boolean {
  if (asset !== path.startsWith("/") || /[\\%?#\u0000-\u0020\u007f]/.test(path)) return false
  const segments = (asset ? path.slice(1) : path).split("/")
  return segments.every(segment => segment !== "" && segment !== "." && segment !== "..")
}

function validateManifest(manifest: Manifest) {
  const parts = new Set<string>()
  const paths = new Set<string>()
  let assets = 0
  for (const file of manifest.files) {
    const key = `${file.role}:${file.path}`
    if (parts.has(file.part) || paths.has(key) || file.path === "metadata" || !validPath(file.path, file.role === "asset")) {
      throw new PageError("invalid_file_mapping")
    }
    parts.add(file.part)
    paths.add(key)
    if (file.role === "module" && !moduleTypes.some(type => type === file.type)) throw new PageError("unsupported_module_type")
    if (file.role === "asset") {
      assets++
      if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:; ?charset=[\w-]+)?$/.test(file.type)) throw new PageError("invalid_asset_type")
    }
  }
  if (Object.keys(manifest.variables).length > 64 || Object.keys(manifest.variables).some(name =>
    ["ASSETS", "REGISTRY", "DISPATCHER", "PAGES_API_TOKEN", "CF_ACCOUNT_ID", "CF_NAMESPACE"].includes(name))) {
    throw new PageError("invalid_variables")
  }
  if (new Set(manifest.compatibilityFlags).size !== manifest.compatibilityFlags.length) throw new PageError("invalid_compatibility_flags")
  if (!assets && manifest.assets) throw new PageError("assets_config_without_assets")
  const modules = manifest.files.filter(file => file.role === "module")
  if (!manifest.entry) {
    if (modules.length || !assets) throw new PageError("missing_entry")
    return
  }
  const entry = modules.find(file => file.path === manifest.entry?.path)
  const expected = { module: "application/javascript+module", classic: "application/javascript", python: "text/x-python" }
  if (!entry || entry.type !== expected[manifest.entry.format]) throw new PageError("invalid_entry")
  if (manifest.entry.format === "classic" && (modules.length !== 1 || assets)) throw new PageError("unsupported_classic_combination")
  if (manifest.entry.format !== "python" && modules.some(file => file.type.startsWith("text/x-python"))) throw new PageError("invalid_python_combination")
}

export async function sha256(value: BufferSource): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", value))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
}

export async function parseUpload(request: Request, config: Settings): Promise<Artifact> {
  const contentType = request.headers.get("content-type") ?? ""
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) throw new PageError("multipart_required")
  const bytes = await boundedBytes(request.body, config.uploadBytes)
  let form: FormData
  try {
    form = await new Response(bytes, { headers: { "content-type": contentType } }).formData()
  } catch {
    throw new PageError("invalid_multipart")
  }
  const raw = form.get("manifest")
  if (form.getAll("manifest").length !== 1 || typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > 65_536) {
    throw new PageError("invalid_manifest")
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new PageError("invalid_manifest") }
  const result = manifestSchema.safeParse(parsed)
  if (!result.success) throw new PageError("invalid_manifest")
  const manifest = result.data
  validateManifest(manifest)
  if (manifest.files.length > config.fileCount || [...form.keys()].length !== manifest.files.length + 1) throw new PageError("invalid_part_count")
  const files: UploadFile[] = []
  for (const mapping of manifest.files) {
    const file = form.get(mapping.part)
    if (!(file instanceof Blob) || form.getAll(mapping.part).length !== 1) throw new PageError("invalid_file_part")
    if (file.size > config.fileBytes) throw new PageError("file_too_large", 413)
    const hash = await sha256(await file.arrayBuffer())
    const type = mapping.type.toLowerCase()
    const base = { path: mapping.path, type, blob: file, hash }
    if (mapping.role === "asset") {
      const assetHash = (await sha256(new TextEncoder().encode(JSON.stringify(["alook-assets-v1", hash, type])))).slice(0, 32)
      files.push({ ...base, role: "asset", assetHash })
    } else files.push({ ...base, role: "module" })
  }
  const canonical = JSON.stringify({ manifest, hashes: files.map(file => [file.path, file.hash]) })
  return { manifest, files, digest: await sha256(new TextEncoder().encode(canonical)) }
}
