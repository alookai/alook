import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
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

  // OpenNext derives the Edge OG runtime from the original route trace, even though
  // Next has already copied that runtime into the standalone tree. A restored pnpm
  // store can occasionally leave the original file absent on Linux, so recover it
  // from Next's self-contained output before OpenNext applies its OG patch.
  const ogTrace = resolve(nextRoot, "server/app/og/blog/[slug]/route.js.nft.json")
  if (existsSync(ogTrace)) {
    const trace = JSON.parse(readFileSync(ogTrace, "utf8")) as { files?: unknown }
    if (!Array.isArray(trace.files) || !trace.files.every((file) => typeof file === "string")) {
      throw new Error(`Invalid OG route trace: ${ogTrace}`)
    }
    const tracedNodePath = trace.files.find((file) => file.endsWith("@vercel/og/index.node.js"))
    if (tracedNodePath) {
      const tracedEdgePath = tracedNodePath.replace(/index\.node\.js$/, "index.edge.js")
      const originalEdge = resolve(dirname(ogTrace), tracedEdgePath)
      if (!existsSync(originalEdge)) {
        const nestedTrace = resolve(nestedNext, relative(nextRoot, ogTrace))
        const standaloneEdge = resolve(dirname(nestedTrace), tracedEdgePath)
        if (!existsSync(standaloneEdge)) {
          throw new Error(`Missing standalone @vercel/og Edge runtime: ${standaloneEdge}`)
        }
        mkdirSync(dirname(originalEdge), { recursive: true })
        copyFileSync(standaloneEdge, originalEdge)
      }
    }
  }
}

const scriptPath = fileURLToPath(import.meta.url)
/* istanbul ignore if */
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  prepareOpenNextStandalone(resolve(dirname(scriptPath), "../.."))
  console.log("Prepared nested Blog standalone output for OpenNext packaging.")
}
