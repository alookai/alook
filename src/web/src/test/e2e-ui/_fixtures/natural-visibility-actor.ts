import type { Browser, BrowserContext, BrowserType, Page } from "@playwright/test"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

export type NaturalActorReceipt = {
  pid: number | null
  startedAt: string
  profile: string
  headless: true
  connection: "CDP noDefaults existing default context"
  processGroupReleased: boolean
  profileRemoved: boolean
  cleanupErrors: number
}

/** A new process/profile per case. No normal-context or private-driver override. */
export function createNaturalVisibilityActor(input: {
  browserType: BrowserType
  profileRoot: string
  storageState: string
  viewport: { width: number; height: number }
  registerContext: (context: BrowserContext) => void
  closeContext: (context: BrowserContext) => Promise<void>
  receipt: (value: NaturalActorReceipt) => Promise<unknown>
}): { ready: Promise<{ context: BrowserContext; page: Page }>; close: () => Promise<void> } {
  if (process.platform === "win32") throw new Error("Natural visibility actor requires an owned Unix process group")
  if (input.browserType.name() !== "chromium") throw new Error("Natural visibility actor requires Chromium")
  const executable = input.browserType.executablePath()
  const profile = mkdtempSync(join(input.profileRoot, "natural-chromium-"))
  const startedAt = new Date().toISOString()
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(executable, [
      "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
      "--use-mock-keychain",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, "about:blank",
    ], { detached: true, stdio: ["ignore", "ignore", "pipe"] })
  } catch (error) {
    rmSync(profile, { recursive: true, force: true })
    throw error
  }
  const exited = new Promise<void>(done => child.once("close", () => done()))
  let connection: Browser | undefined
  let context: BrowserContext | undefined
  let closing = false
  let closed: Promise<void> | undefined
  const endpoint = new Promise<string>((resolve, reject) => {
    let buffered = ""
    const onData = (chunk: Buffer) => {
      buffered = (buffered + chunk.toString()).slice(-8192)
      const match = buffered.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/)
      if (!match) return
      child.stderr?.off("data", onData)
      resolve(match[1]!)
    }
    child.stderr?.on("data", onData)
    child.once("error", reject)
    child.once("close", () => { child.stderr?.off("data", onData); reject(new Error("Owned Chromium closed before its debugging endpoint")) })
  })
  const ready = (async () => {
    connection = await input.browserType.connectOverCDP(await endpoint, { noDefaults: true })
    if (closing) throw new Error("Natural visibility actor retired during connection")
    const contexts = connection.contexts()
    if (contexts.length !== 1) throw new Error("Owned Chromium must expose one existing default context")
    const existing = contexts[0]!
    input.registerContext(existing)
    context = existing
    // Only cookie-only initial Alice in this new profile; Bob still signs in in the document.
    const initialState: unknown = JSON.parse(readFileSync(input.storageState, "utf8"))
    if (!initialState || typeof initialState !== "object"
      || !("cookies" in initialState) || !Array.isArray(initialState.cookies)
      || !("origins" in initialState) || !Array.isArray(initialState.origins) || initialState.origins.length !== 0
      || Object.keys(initialState).some(key => key !== "cookies" && key !== "origins")) {
      throw new Error("Natural actor initial state must contain only cookies and an empty origins array")
    }
    await context.addCookies(initialState.cookies)
    if (closing) throw new Error("Natural visibility actor retired during initial state")
    const pages = context.pages()
    const page = pages[0] ?? await context.newPage()
    for (const extra of pages.slice(1)) await extra.close()
    await page.setViewportSize(input.viewport)
    if (closing) throw new Error("Natural visibility actor retired during page setup")
    return { context, page }
  })()
  void ready.catch(() => {})
  const groupAlive = () => {
    if (!child.pid) return false
    try { process.kill(-child.pid, 0); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
      throw error
    }
  }
  const signal = (value: NodeJS.Signals) => {
    if (!child.pid || !groupAlive()) return
    process.kill(-child.pid, value)
  }
  const waitForGroup = async (milliseconds: number) => {
    const deadline = Date.now() + milliseconds
    while (groupAlive() && Date.now() < deadline) await new Promise(done => setTimeout(done, 50))
    return !groupAlive()
  }
  const close = () => closed ??= (async () => {
    closing = true
    const errors: unknown[] = []
    const disconnect = (async () => {
      if (context) await input.closeContext(context)
      if (connection?.isConnected()) await connection.close()
    })()
    void disconnect.catch(() => {})
    let grace: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([disconnect, new Promise<void>(done => { grace = setTimeout(done, 5000) })])
    } catch (error) { errors.push(error) }
    finally { if (grace) clearTimeout(grace) }
    let released = false
    let removed = false
    try {
      signal("SIGTERM")
      if (!(await waitForGroup(5000))) {
        signal("SIGKILL")
        if (!(await waitForGroup(2000))) throw new Error("Owned Chromium process group did not stop")
      }
      await exited
      await ready.catch(() => {})
      // A connection can complete while retirement is beginning.
      if (connection?.isConnected()) await connection.close()
      await disconnect.catch(error => { if (!errors.includes(error)) errors.push(error) })
      released = true
      rmSync(profile, { recursive: true, force: true })
      removed = true
    } catch (error) { errors.push(error) }
    await input.receipt({ pid: child.pid ?? null, startedAt, profile, headless: true,
      connection: "CDP noDefaults existing default context", processGroupReleased: released,
      profileRemoved: removed, cleanupErrors: errors.length })
    if (errors.length) throw new AggregateError(errors, "Natural visibility actor cleanup failed")
  })()
  return { ready, close }
}
