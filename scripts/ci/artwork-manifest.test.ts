import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { artworkInputHashes } from "../../src/web/app-store-capture/provenance.mjs"
import { assertArtworkHash, assertArtworkProvenance } from "./artwork-manifest"

const root = resolve(import.meta.dirname, "../..")
const gallery = JSON.parse(readFileSync(join(root, "assets/app-store/manifest.json"), "utf8"))
const creative = JSON.parse(readFileSync(join(root, "assets/app-store/creative/manifest.json"), "utf8"))
const paths = gallery.outputs.map(output => output.path)
const batches = () => ({ ...gallery, renderBatches: [
  { renderer: gallery.renderer, clock: gallery.clock, inputs: creative.inputs, outputPaths: paths.slice(0, 1) },
  { renderer: gallery.renderer, clock: gallery.clock, inputs: gallery.inputs, outputPaths: paths.slice(1) },
] })

describe("saved artwork integrity independent of current source", () => {
  it("keeps real recorded digests valid after their source bytes change", () => {
    const directory = mkdtempSync(join(tmpdir(), "alook-saved-artwork-"))
    try {
      const file = join(directory, "surface.css")
      writeFileSync(file, "body { color: red }")
      const inputs = artworkInputHashes([file], [])
      const saved = { inputs }
      assertArtworkProvenance(saved, [])
      writeFileSync(file, "body { color: blue }")
      expect(artworkInputHashes([file], [])).not.toEqual(inputs)
      expect(() => assertArtworkProvenance(saved, [])).not.toThrow()
      expect(saved.inputs).toBe(inputs)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it("accepts historical batches with different real source closures", () => {
    expect(Object.keys(creative.inputs).sort()).not.toEqual(Object.keys(gallery.inputs).sort())
    expect(() => assertArtworkProvenance(batches(), paths)).not.toThrow()
    expect(() => assertArtworkProvenance(creative, creative.outputs.map(output => output.path))).not.toThrow()
  })
  it.each([null, [], {}, { source: "invalid" }, { "": Object.values(gallery.inputs)[0] }, { source: 42 }])("rejects malformed saved inputs %j", inputs => {
    expect(() => assertArtworkProvenance({ inputs }, paths)).toThrow("Invalid recorded artwork inputs")
  })
  it.each([null, {}, []])("rejects invalid batch collections %j", renderBatches => {
    expect(() => assertArtworkProvenance({ ...gallery, renderBatches }, paths)).toThrow("Invalid artwork render batches")
  })
  it.each([null, { renderer: "invalid" }, { clock: "wrong" }, { outputPaths: [] }, { outputPaths: [null] }, { inputs: {} }])("rejects malformed batch %j", change => {
    const manifest = batches()
    manifest.renderBatches[0] = change === null ? null : { ...manifest.renderBatches[0], ...change }
    expect(() => assertArtworkProvenance(manifest, paths)).toThrow()
  })
  it.each(["duplicate", "missing", "latest-inputs", "latest-key-set", "latest-value"])("rejects inconsistent %s records", change => {
    const manifest = batches()
    if (change === "duplicate") manifest.renderBatches[1].outputPaths.push(paths[0])
    if (change === "missing") manifest.renderBatches[1].outputPaths.pop()
    if (change === "latest-inputs") manifest.renderBatches[1].inputs = creative.inputs
    if (change === "latest-key-set") manifest.renderBatches[1].inputs = { ...gallery.inputs, ...creative.inputs }
    if (change === "latest-value") {
      const [key, hash] = Object.entries(gallery.inputs)[0]
      manifest.renderBatches[1].inputs = { ...gallery.inputs, [key]: Object.values(gallery.inputs).find(value => value !== hash) }
    }
    expect(() => assertArtworkProvenance(manifest, paths)).toThrow()
  })
  it("still rejects corrupted output bytes and missing or malformed output hashes", () => {
    const output = gallery.outputs[0]
    const bytes = readFileSync(join(root, "assets/app-store", output.path))
    expect(() => assertArtworkHash(bytes, output.sha256)).not.toThrow()
    const corrupt = Buffer.from(bytes)
    corrupt[0] ^= 1
    expect(() => assertArtworkHash(corrupt, output.sha256)).toThrow("Artwork output hash mismatch")
    for (const hash of [undefined, "invalid", gallery.outputs[1].sha256]) expect(() => assertArtworkHash(bytes, hash)).toThrow("Artwork output hash mismatch")
  })
})
