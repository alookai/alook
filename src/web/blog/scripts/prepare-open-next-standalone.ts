import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export function prepareOpenNextStandalone(webRoot: string): void {
  const nextRoot = resolve(webRoot, "blog/.next")
  const nestedNext = resolve(webRoot, "blog/.next/standalone/src/web/blog/.next")
  const instrumentationSource = resolve(webRoot, "blog/.next/server/instrumentation.js")
  const instrumentationDestination = resolve(nestedNext, "server/instrumentation.js")
  const instrumentationTrace = `${instrumentationSource}.nft.json`

  if (!existsSync(nestedNext)) {
    throw new Error(`Nested Blog standalone output is missing: ${nestedNext}`)
  }
  if (existsSync(instrumentationSource) && !existsSync(instrumentationDestination)) {
    copyFileSync(instrumentationSource, instrumentationDestination)
  }
  if (existsSync(instrumentationTrace)) {
    const trace = JSON.parse(readFileSync(instrumentationTrace, "utf8")) as { files?: unknown }
    if (!Array.isArray(trace.files) || !trace.files.every((file) => typeof file === "string")) {
      throw new Error(`Invalid instrumentation trace: ${instrumentationTrace}`)
    }
    for (const file of trace.files) {
      const source = resolve(instrumentationSource, "..", file)
      const destination = resolve(instrumentationDestination, "..", file)
      if (!existsSync(source)) throw new Error(`Missing instrumentation dependency: ${source}`)
      if (!existsSync(destination)) {
        mkdirSync(resolve(destination, ".."), { recursive: true })
        copyFileSync(source, destination)
      }
    }
  }

  const ogTrace = resolve(nextRoot, "server/app/og/blog/[slug]/route.js.nft.json")
  if (!existsSync(ogTrace)) return

  const trace = JSON.parse(readFileSync(ogTrace, "utf8")) as { files?: unknown }
  if (!Array.isArray(trace.files) || !trace.files.every((file) => typeof file === "string")) {
    throw new Error(`Invalid OG route trace: ${ogTrace}`)
  }
  const tracedNodePath = trace.files.find((file) => file.endsWith("@vercel/og/index.node.js"))
  if (!tracedNodePath) return

  const nestedTrace = resolve(nestedNext, relative(nextRoot, ogTrace))
  const logicalOgDirectory = resolve(webRoot, "blog/node_modules/next/dist/compiled/@vercel/og")
  const ogPathMarker = "@vercel/og/"
  const tracedOgPrefix = tracedNodePath.slice(
    0,
    tracedNodePath.indexOf(ogPathMarker) + ogPathMarker.length,
  )
  const tracedOgPaths = trace.files.filter((file) => file.startsWith(tracedOgPrefix))
  for (const fileName of ["index.edge.js", "yoga.wasm"]) {
    const tracedPath = `${tracedOgPrefix}${fileName}`
    if (!tracedOgPaths.includes(tracedPath)) tracedOgPaths.push(tracedPath)
  }

  for (const tracedPath of tracedOgPaths) {
    const logicalPath = relative(
      dirname(ogTrace),
      resolve(logicalOgDirectory, tracedPath.slice(tracedOgPrefix.length)),
    )
    const tracedSource = resolve(dirname(nestedTrace), tracedPath)
    const logicalDestination = resolve(dirname(nestedTrace), logicalPath)
    if (!existsSync(tracedSource)) {
      throw new Error(`Missing traced standalone @vercel/og runtime source: ${tracedSource}`)
    }
    if (!existsSync(logicalDestination)) {
      mkdirSync(dirname(logicalDestination), { recursive: true })
      copyFileSync(tracedSource, logicalDestination)
    }
    if (!trace.files.includes(logicalPath)) trace.files.push(logicalPath)
  }
  writeFileSync(ogTrace, JSON.stringify(trace))
}

const scriptPath = fileURLToPath(import.meta.url)
/* istanbul ignore if */
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  prepareOpenNextStandalone(resolve(dirname(scriptPath), "../.."))
  console.log("Prepared nested Blog standalone output for OpenNext packaging.")
}
