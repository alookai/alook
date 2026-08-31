import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export function prepareOpenNextStandalone(webRoot: string): void {
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
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  prepareOpenNextStandalone(resolve(dirname(scriptPath), "../.."))
  console.log("Prepared nested Blog standalone output for OpenNext packaging.")
}
