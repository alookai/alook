// Read only the block mappings emitted by pnpm's v9 lockfile writer. Keep the
// full selected package/snapshot records, including integrity and peer bindings.
function scalar(value) {
  return value.startsWith("'") ? value.slice(1, -1).replaceAll("''", "'") : value
}

function entries(text, indent) {
  const result = new Map()
  const pattern = new RegExp(`^ {${indent}}(\\S[^\\n]*?):(?: \\{\\})?(?:\\n|$)`, "gm")
  const matches = [...text.matchAll(pattern)]
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]
    const key = scalar(match[1])
    if (result.has(key)) throw new Error(`Duplicate pnpm lock entry: ${key}`)
    result.set(key, text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).trimEnd())
  }
  return result
}

export function parsePnpmLock(text) {
  text = text.replaceAll("\r\n", "\n")
  if (!/^lockfileVersion: ['"]?9\.0['"]?$/m.test(text)) throw new Error("Expected pnpm lockfile v9")
  const sections = entries(text, 0)
  return {
    importers: entries(sections.get("importers") ?? "", 2),
    packages: entries(sections.get("packages") ?? "", 2),
    snapshots: entries(sections.get("snapshots") ?? "", 2),
    patches: entries(sections.get("patchedDependencies") ?? "", 2),
  }
}

export function lockedDependency(lock, importer, name) {
  const body = lock.importers.get(importer)
  if (body === undefined) throw new Error(`Missing pnpm importer: ${importer}`)
  const matches = [...body.matchAll(/^ {6}(\S[^\n]*?):\n {8}specifier: ([^\n]+)\n {8}version: ([^\n]+)/gm)]
    .filter(match => scalar(match[1]) === name)
  if (matches.length !== 1) throw new Error(`Expected one locked dependency: ${importer}:${name}`)
  return { specifier: scalar(matches[0][2]), version: scalar(matches[0][3]) }
}

export function projectDependencies(lock, roots) {
  const records = {}
  function visit(name, version) {
    if (/^(?:link:|workspace:)/.test(version)) throw new Error(`Expected external dependency: ${name}`)
    const reference = version.replace(/^npm:/, "")
    const key = /^[0-9]/.test(reference) ? `${name}@${reference}` : reference
    if (records[`snapshot:${key}`] !== undefined) return
    const snapshot = lock.snapshots.get(key)
    const packageKey = key.split("(")[0]
    const metadata = lock.packages.get(packageKey)
    if (snapshot === undefined || metadata === undefined) throw new Error(`Missing locked renderer dependency: ${key}`)
    records[`package:${packageKey}`] = metadata
    records[`snapshot:${key}`] = snapshot
    if (lock.patches.has(packageKey)) records[`patch:${packageKey}`] = lock.patches.get(packageKey)
    for (const match of snapshot.matchAll(/^ {6}(\S[^\n]*?): (\S[^\n]*)$/gm)) {
      visit(scalar(match[1]), scalar(match[2]))
    }
  }
  for (const { importer, name } of roots) {
    const { version } = lockedDependency(lock, importer, name)
    // The selected resolution matters; unrelated manifest scripts/ranges do not.
    records[`root:${importer}:${name}`] = version
    visit(name, version)
  }
  return Object.fromEntries(Object.entries(records).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}
