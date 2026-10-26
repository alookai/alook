import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parsePnpmLock, lockedDependency, projectDependencies } from "./pnpm-lock.mjs"
import { artworkInputHashes, sourceInputs } from "../../src/web/app-store-capture/provenance.mjs"
import { captureInputHashes } from "../../src/web/app-store-capture/capture.mjs"
import { creativeInputHashes } from "../../src/web/app-store-capture/creative/capture.mjs"

const root = resolve(import.meta.dirname, "../..")
const lockText = readFileSync(join(root, "pnpm-lock.yaml"), "utf8")
const roots = [{ importer: "src/web", name: "sharp" }]

describe("renderer-scoped artwork provenance", () => {
  it("retains selected transitive integrity, peers and patches without unrelated lock entries", () => {
    const lock = parsePnpmLock(lockText)
    const selected = projectDependencies(lock, roots)
    const version = lockedDependency(lock, "src/web", "sharp").version.split("(")[0]
    expect(selected[`package:sharp@${version}`]).toContain("integrity:")
    expect(Object.keys(selected).some(key => key.startsWith("package:@img/"))).toBe(true)
    expect(Object.keys(selected).some(key => key.startsWith("package:turbo@"))).toBe(false)
    const unrelated = parsePnpmLock(lockText)
    unrelated.packages.set("turbo@0.0.0", "    resolution: {integrity: changed}")
    unrelated.importers.set("src/email-worker", "irrelevant change")
    expect(projectDependencies(unrelated, roots)).toEqual(selected)
    const relevant = parsePnpmLock(lockText)
    const transitive = Object.keys(selected).find(key => key.startsWith("package:@img/"))!.slice("package:".length)
    relevant.packages.set(transitive, `${relevant.packages.get(transitive)}\n    changed: true`)
    expect(projectDependencies(relevant, roots)).not.toEqual(selected)
    const patched = projectDependencies(lock, [{ importer: "src/web", name: "@base-ui/react" }])
    expect(Object.keys(patched).some(key => key.startsWith("patch:@base-ui/react@"))).toBe(true)
  })

  it("fails closed on missing selected records, duplicate entries and unsupported lock formats", () => {
    const lock = parsePnpmLock(lockText)
    const selected = lockedDependency(lock, "src/web", "sharp")
    lock.snapshots.delete(`sharp@${selected.version}`)
    expect(() => projectDependencies(lock, roots)).toThrow("Missing locked renderer dependency")
    expect(() => lockedDependency(lock, "missing", "sharp")).toThrow("Missing pnpm importer")
    expect(() => lockedDependency(lock, "src/web", "absent")).toThrow("Expected one locked dependency")
    expect(() => parsePnpmLock("lockfileVersion: '8.0'\n")).toThrow("Expected pnpm lockfile v9")
    expect(() => parsePnpmLock(`${lockText}\n  duplicate@1.0.0: {}\n  duplicate@1.0.0: {}\n`)).toThrow("Duplicate pnpm lock entry")
  })

  it("changes for actual source bytes and selected dependency bytes, while ignoring unrelated lock changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "alook-artwork-input-"))
    try {
      const file = join(directory, "artwork.css")
      writeFileSync(file, "body { color: red }")
      const original = artworkInputHashes([file], roots, lockText)
      const unrelated = lockText.replace(/(  turbo@[^\n]+:\n    resolution: )[^\n]+/, "$1{integrity: irrelevant}")
      expect(unrelated).not.toBe(lockText)
      expect(artworkInputHashes([file], roots, unrelated)).toEqual(original)
      const relevant = lockText.replace(/(  sharp@[^\n]+:\n    resolution: )[^\n]+/, "$1{integrity: changed}")
      expect(relevant).not.toBe(lockText)
      expect(artworkInputHashes([file], roots, relevant)).not.toEqual(original)
      writeFileSync(file, "body { color: blue }")
      expect(artworkInputHashes([file], roots, lockText)).not.toEqual(original)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it("follows real local component imports and binds both producers without global package hashes", async () => {
    const inputs = sourceInputs([join(root, "src/web/app-store-capture/captures/surface.tsx")])
    expect(inputs.files).toContain(join(root, "src/web/src/components/community/messages/message.tsx"))
    expect(inputs.roots).toContainEqual({ importer: "src/web", name: "react" })
    for (const hashes of [await captureInputHashes(), await creativeInputHashes()]) {
      expect(Object.keys(hashes)).not.toContain("pnpm-lock.yaml")
      expect(Object.keys(hashes)).not.toContain("package.json")
      expect(hashes["renderer:pnpm-dependencies"]).toMatch(/^[a-f0-9]{64}$/)
      expect(Object.values(hashes).every(hash => /^[a-f0-9]{64}$/.test(hash))).toBe(true)
    }
  })
})
