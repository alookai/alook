import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

type TestEvent = {
  defaultPrevented?: boolean
  key?: string
  preventDefault?: () => void
}

type Listener = (event: TestEvent) => void

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type)
    listeners?.delete(listener)
    if (listeners?.size === 0) this.listeners.delete(type)
  }

  dispatch(type: string, event: TestEvent = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    return event
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0
  }
}

class FakeElement extends FakeEventTarget {
  readonly attributes = new Map<string, string>()
  focusCalls = 0
  textContent: string

  constructor(textContent = "") {
    super()
    this.textContent = textContent
  }

  focus() {
    this.focusCalls += 1
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
}

class FakeDocument extends FakeEventTarget {
  hidden = false

  constructor(
    private readonly surface: FakeElement,
    private readonly message: FakeElement,
  ) {
    super()
  }

  querySelector(selector: string) {
    if (selector === '[data-testid="webview-recovery"]') return this.surface
    if (selector === '[data-testid="recovery-message"]') return this.message
    return null
  }
}

const repositoryRoot = resolve(import.meta.dirname, "../..")
const rustSource = readFileSync(
  resolve(repositoryRoot, "src/desktop/src-tauri/src/webview_recovery.rs"),
  "utf8",
)
const recoveryHtml = rustSource.match(
  /fn recovery_html\(\) -> &'static str \{\s*r##"([\s\S]*?)"##\s*\}/,
)?.[1]

if (!recoveryHtml) throw new Error("recovery HTML not found")

const recoveryScript = recoveryHtml.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1]

if (!recoveryScript) throw new Error("recovery script not found")

const defaultMessage = "Network connection failed. Click to refresh"

const createHarness = (
  target = "https://alook.ai/c/channel?after=%23one&view=all#message-7",
  replace = vi.fn(),
) => {
  const surface = new FakeElement()
  const message = new FakeElement(defaultMessage)
  const document = new FakeDocument(surface, message)
  const window = new FakeEventTarget()
  const location = {
    hash: `#${new URLSearchParams({ target }).toString()}`,
    replace,
  }

  runInNewContext(recoveryScript, {
    URL,
    URLSearchParams,
    document,
    location,
    window,
  })

  return { document, location, message, replace, surface, window }
}

describe("WebView recovery document", () => {
  it("does not focus on load and confines the keyboard ring to the refresh icon", () => {
    const { surface } = createHarness()

    expect(surface.focusCalls).toBe(0)
    expect(recoveryHtml).toContain(
      "main:focus-visible svg{outline:3px solid var(--ring);outline-offset:4px",
    )
    expect(recoveryHtml).not.toContain("autofocus")
    expect(recoveryHtml).not.toMatch(/main:focus-visible\{[^}]*outline:3px/)
  })

  it("retries the exact target once on online", () => {
    const harness = createHarness()

    harness.window.dispatch("online")
    harness.window.dispatch("online")

    expect(harness.replace).toHaveBeenCalledOnce()
    expect(harness.replace).toHaveBeenCalledWith(
      "https://alook.ai/c/channel?after=%23one&view=all#message-7",
    )
  })

  it("retries only after blur is followed by focus", () => {
    const harness = createHarness()

    harness.window.dispatch("focus")
    expect(harness.replace).not.toHaveBeenCalled()

    harness.window.dispatch("blur")
    harness.window.dispatch("focus")
    harness.window.dispatch("focus")

    expect(harness.replace).toHaveBeenCalledOnce()
  })

  it("retries only after hidden is followed by visible", () => {
    const harness = createHarness()

    harness.document.dispatch("visibilitychange")
    expect(harness.replace).not.toHaveBeenCalled()

    harness.document.hidden = true
    harness.document.dispatch("visibilitychange")
    harness.document.hidden = false
    harness.document.dispatch("visibilitychange")
    harness.document.dispatch("visibilitychange")

    expect(harness.replace).toHaveBeenCalledOnce()
  })

  it("deduplicates concurrent manual and lifecycle retries", () => {
    const harness = createHarness()
    const keyEvent: TestEvent = {
      key: "Enter",
      preventDefault() {
        this.defaultPrevented = true
      },
    }

    harness.surface.dispatch("click")
    harness.surface.dispatch("keydown", keyEvent)
    harness.window.dispatch("online")
    harness.window.dispatch("blur")
    harness.window.dispatch("focus")
    harness.document.hidden = true
    harness.document.dispatch("visibilitychange")
    harness.document.hidden = false
    harness.document.dispatch("visibilitychange")

    expect(keyEvent.defaultPrevented).toBe(true)
    expect(harness.replace).toHaveBeenCalledOnce()
    expect(harness.message.textContent).toBe("Retrying…")
  })

  it.each(["Enter", " "])("supports the %j manual retry key", (key) => {
    const harness = createHarness()
    const event: TestEvent = {
      key,
      preventDefault() {
        this.defaultPrevented = true
      },
    }

    harness.surface.dispatch("keydown", event)

    expect(event.defaultPrevented).toBe(true)
    expect(harness.replace).toHaveBeenCalledOnce()
  })

  it("restores the recovery state after a synchronous navigation failure", () => {
    const replace = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("navigation rejected")
      })
      .mockImplementationOnce(() => undefined)
    const harness = createHarness(undefined, replace)

    harness.surface.dispatch("click")

    expect(harness.surface.attributes.get("aria-disabled")).toBe("false")
    expect(harness.message.textContent).toBe(defaultMessage)

    harness.window.dispatch("online")

    expect(replace).toHaveBeenCalledTimes(2)
    expect(harness.message.textContent).toBe("Retrying…")
  })

  it("fails closed for invalid targets", () => {
    const harness = createHarness("javascript:alert(1)")

    harness.surface.dispatch("click")
    harness.window.dispatch("online")

    expect(harness.surface.attributes.get("aria-disabled")).toBe("true")
    expect(harness.replace).not.toHaveBeenCalled()
  })

  it("removes all listeners on pagehide", () => {
    const harness = createHarness()

    expect(harness.window.listenerCount("pagehide")).toBe(1)
    harness.window.dispatch("pagehide")

    for (const type of ["online", "blur", "focus", "pagehide"]) {
      expect(harness.window.listenerCount(type)).toBe(0)
    }
    expect(harness.document.listenerCount("visibilitychange")).toBe(0)
    expect(harness.surface.listenerCount("click")).toBe(0)
    expect(harness.surface.listenerCount("keydown")).toBe(0)

    harness.surface.dispatch("click")
    harness.window.dispatch("online")
    expect(harness.replace).not.toHaveBeenCalled()
  })

  it("has no polling or reload loop and does not claim connectivity succeeded", () => {
    expect(recoveryScript).not.toContain("setTimeout")
    expect(recoveryScript).not.toContain("setInterval")
    expect(recoveryScript).not.toContain("location.reload")
    expect(recoveryScript).not.toContain("navigator.onLine")
    expect(recoveryHtml).not.toContain("Back online")
    expect(recoveryHtml).not.toContain("Connected")
  })
})
