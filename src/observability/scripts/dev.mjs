import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startManagedCollector } from "./managed.mjs"

export async function runStandalone({ runtime = process, start = startManagedCollector, root = fileURLToPath(new URL("../../../", import.meta.url)) } = {}) {
  const lifetime = new AbortController()
  let collector
  let stopping
  const signals = ["SIGINT", "SIGTERM"]
  const interrupted = () => { void shutdown(0) }
  async function shutdown(code = 0) {
    if (stopping) return stopping
    lifetime.abort(new Error("Standalone observations stopped"))
    for (const signal of signals) runtime.removeListener(signal, interrupted)
    runtime.exitCode = code
    stopping = Promise.resolve(collector?.stop())
    return stopping
  }
  for (const signal of signals) runtime.once(signal, interrupted)
  try {
    collector = await start({ root, signal: lifetime.signal, onExit: () => { void shutdown(1) } })
    if (lifetime.signal.aborted) await collector.stop()
  } catch (error) {
    if (!lifetime.signal.aborted) console.error(error)
    await shutdown(lifetime.signal.aborted ? 0 : 1)
  }
  return { stop: shutdown }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runStandalone()
