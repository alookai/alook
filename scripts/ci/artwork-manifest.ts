import { createHash } from "node:crypto"

function recordedInputs(value: unknown): asserts value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Object.keys(value).length || Object.entries(value).some(([key, hash]) => !key.trim()
      || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw new Error("Invalid recorded artwork inputs")
}

export function assertArtworkProvenance(manifest: { inputs: unknown; clock?: unknown; renderBatches?: unknown }, outputPaths: string[]) {
  recordedInputs(manifest.inputs)
  if (manifest.renderBatches === undefined) return
  if (!Array.isArray(manifest.renderBatches) || !manifest.renderBatches.length) throw new Error("Invalid artwork render batches")
  const paths: string[] = []
  for (const batch of manifest.renderBatches) {
    if (!batch || typeof batch.renderer !== "string" || !/^\d+\./.test(batch.renderer)
      || typeof batch.clock !== "string" || batch.clock !== manifest.clock
      || !Array.isArray(batch.outputPaths) || !batch.outputPaths.length
      || batch.outputPaths.some(path => typeof path !== "string" || !path)) throw new Error("Invalid artwork render batch")
    recordedInputs(batch.inputs)
    paths.push(...batch.outputPaths)
  }
  if (new Set(paths).size !== paths.length || JSON.stringify([...paths].sort()) !== JSON.stringify([...outputPaths].sort())) {
    throw new Error("Artwork render batches must cover each output once")
  }
  const latest = manifest.renderBatches.at(-1).inputs as Record<string, string>
  if (Object.keys(latest).length !== Object.keys(manifest.inputs).length
    || Object.entries(manifest.inputs).some(([key, hash]) => latest[key] !== hash)) throw new Error("Latest artwork inputs do not match the manifest")
}

export function assertArtworkHash(bytes: Uint8Array, sha256: unknown) {
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
    || createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Artwork output hash mismatch")
}
