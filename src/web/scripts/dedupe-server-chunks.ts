import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { basename, dirname, relative, resolve, sep } from "node:path"

type Alias = { duplicate: string; canonical: string }

function filesIn(directory: string): string[] {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return []
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap(entry => entry.isDirectory() ? filesIn(resolve(directory, entry.name))
      : entry.isFile() ? [resolve(directory, entry.name)] : [])
}

function executableChunk(source: string, filename: string): string | undefined {
  const marker = "\n//# sourceMappingURL="
  const offset = source.lastIndexOf(marker)
  const code = offset >= 0 && source.slice(offset + marker.length).trimEnd() === `${basename(filename)}.map`
    ? source.slice(0, offset) : source
  if (!/^(?:module\.exports=\[|\(\(\)=>\{"use strict";module\.exports=\[)/.test(code)) return
  if (/\b(?:__filename|__dirname)\b|\bmodule\s*\.\s*(?:filename|id)\b/.test(code)) return
  return code
}

function traceUpdates(nextRoot: string, aliases: Alias[]): Map<string, string> {
  const aliasesBySource = new Map(aliases.map(alias => [alias.duplicate, alias.canonical]))
  const changes = new Map<string, string>()
  const traces = filesIn(resolve(nextRoot, "server")).filter(filename => filename.endsWith(".nft.json"))
  for (const name of readdirSync(nextRoot)) {
    const filename = resolve(nextRoot, name)
    if (name.endsWith(".nft.json") && lstatSync(filename).isFile()) traces.push(filename)
  }
  for (const filename of traces) {
    const trace = JSON.parse(readFileSync(filename, "utf8")) as { files?: unknown }
    if (!Array.isArray(trace.files) || !trace.files.every((file): file is string => typeof file === "string")) {
      throw new Error(`Invalid Next file trace: ${filename}`)
    }
    const files = new Set(trace.files)
    let changed = false
    for (const file of trace.files) {
      const canonical = aliasesBySource.get(resolve(dirname(filename), file))
      if (!canonical) continue
      const dependency = relative(dirname(filename), canonical).split(sep).join("/")
      if (!files.has(dependency)) {
        files.add(dependency)
        changed = true
      }
    }
    if (changed) changes.set(filename, JSON.stringify({ ...trace, files: [...files] }))
  }
  return changes
}

export function dedupeServerChunks(webRoot: string): { aliases: number; savedBytes: number; updatedTraces: number } {
  const nextRoot = resolve(webRoot, ".next")
  const standaloneNext = resolve(nextRoot, "standalone/src/web/.next")
  const chunksRoot = resolve(standaloneNext, "server/chunks")
  const canonicalByCode = new Map<string, string>()
  const writes = new Map<string, string>()
  const aliases: Alias[] = []
  let savedBytes = 0
  for (const filename of filesIn(chunksRoot)) {
    if (!filename.endsWith(".js")) continue
    const source = readFileSync(filename, "utf8")
    const code = executableChunk(source, filename)
    if (!code) continue
    const key = `${dirname(filename)}\0${code}`
    const canonical = canonicalByCode.get(key)
    if (!canonical) {
      canonicalByCode.set(key, filename)
      continue
    }
    const replacement = `module.exports = require(${JSON.stringify(`./${basename(canonical)}`)});\n`
    if (Buffer.byteLength(replacement) >= Buffer.byteLength(source)) continue
    writes.set(filename, replacement)
    savedBytes += Buffer.byteLength(source) - Buffer.byteLength(replacement)
    aliases.push({
      duplicate: resolve(nextRoot, relative(standaloneNext, filename)),
      canonical: resolve(nextRoot, relative(standaloneNext, canonical)),
    })
  }
  const traces = aliases.length ? traceUpdates(nextRoot, aliases) : new Map<string, string>()
  for (const [filename, source] of writes) writeFileSync(filename, source)
  for (const [filename, source] of traces) writeFileSync(filename, source)
  return { aliases: aliases.length, savedBytes, updatedTraces: traces.size }
}
