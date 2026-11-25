import { expect, type Page } from "@playwright/test"

export const DEFAULT_MOBILE_VIEWPORT = { width: 390, height: 844 } as const
export const DEFAULT_KEYBOARD_OPEN_HEIGHT = 520

export type MobileKeyboardMode = "viewport" | "inset"
export type MobileKeyboardState = "open" | "closed"

export interface MobileKeyboardOptions {
  mode?: MobileKeyboardMode
  width?: number
  closedHeight?: number
  openHeight?: number
  insetHeight?: number
  steps?: number
  stepDelayMs?: number
  initialDelayMs?: number
}

export interface MobileKeyboardSnapshot {
  mode: MobileKeyboardMode
  state: MobileKeyboardState
  height: number
  bottomInset: number
  transitions: number
}

export interface MobileKeyboardController {
  open(): Promise<void>
  close(): Promise<void>
  waitForState(state: MobileKeyboardState, timeoutMs?: number): Promise<void>
  getState(): MobileKeyboardSnapshot
  dispose(): Promise<void>
}

interface MobileKeyboardBridgeMessage {
  kind: "focus-change" | "inset-settled"
  state: MobileKeyboardState
  bottomInset?: number
}

let bindingSequence = 0

function interpolate(from: number, to: number, step: number, steps: number): number {
  if (steps <= 1 || step >= steps) return to
  return Math.round(from + ((to - from) * step) / steps)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function installMobileKeyboard(
  page: Page,
  options: MobileKeyboardOptions = {},
): Promise<MobileKeyboardController> {
  const mode: MobileKeyboardMode = options.mode ?? "viewport"
  const width = options.width ?? DEFAULT_MOBILE_VIEWPORT.width
  const closedHeight = options.closedHeight ?? DEFAULT_MOBILE_VIEWPORT.height
  const openHeight = options.openHeight ?? DEFAULT_KEYBOARD_OPEN_HEIGHT
  const insetHeight = options.insetHeight ?? Math.max(0, closedHeight - openHeight)
  const steps = Math.max(1, options.steps ?? 5)
  const stepDelayMs = Math.max(0, options.stepDelayMs ?? 16)
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 16)

  const id = ++bindingSequence
  const signalName = `__alookMobileKeyboardSignal_${id}`
  const driveName = `__alookMobileKeyboardDrive_${id}`

  let currentState: MobileKeyboardState = "closed"
  let currentHeight = closedHeight
  let currentInset = 0
  let animating = false
  let transitions = 0
  let generation = 0
  let disposed = false

  const waiters = new Set<() => void>()
  const notifyWaiters = () => {
    for (const wake of [...waiters]) wake()
  }

  await page.setViewportSize({ width, height: closedHeight })

  const runViewportTransition = (targetState: MobileKeyboardState): Promise<void> => {
    const targetHeight = targetState === "open" ? openHeight : closedHeight
    if (!animating && currentState === targetState && currentHeight === targetHeight) {
      return Promise.resolve()
    }
    const token = ++generation
    animating = true
    const startHeight = currentHeight

    return (async () => {
      try {
        if (initialDelayMs > 0) await sleep(initialDelayMs)
        for (let step = 1; step <= steps; step += 1) {
          if (disposed || token !== generation || page.isClosed()) return
          const nextHeight = interpolate(startHeight, targetHeight, step, steps)
          await page.setViewportSize({ width, height: nextHeight })
          currentHeight = nextHeight
          if (step < steps && stepDelayMs > 0) await sleep(stepDelayMs)
        }
        if (disposed || token !== generation || page.isClosed()) return
        currentHeight = targetHeight
        currentState = targetState
        currentInset = targetState === "open" ? closedHeight - openHeight : 0
        animating = false
        transitions += 1
        notifyWaiters()
      } catch {
        if (token === generation) {
          animating = false
          notifyWaiters()
        }
      }
    })()
  }

  await page.exposeFunction(signalName, (message: MobileKeyboardBridgeMessage) => {
    if (disposed) return
    if (mode === "viewport") {
      if (message.kind === "focus-change") {
        void runViewportTransition(message.state)
      }
      return
    }
    if (message.kind === "focus-change") {
      animating = true
      return
    }
    if (message.kind === "inset-settled") {
      currentState = message.state
      currentInset = message.bottomInset ?? (message.state === "open" ? insetHeight : 0)
      animating = false
      transitions += 1
      notifyWaiters()
    }
  })

  await page.addInitScript(
    ({
      signalName: exposedSignal,
      driveName: exposedDrive,
      mode: initMode,
      width: initWidth,
      insetHeight: initInsetHeight,
      steps: initSteps,
      initialDelayMs: initInitialDelayMs,
    }) => {
      const NON_TEXT_INPUT_TYPES = new Set([
        "button",
        "checkbox",
        "color",
        "file",
        "hidden",
        "image",
        "radio",
        "range",
        "reset",
        "submit",
      ])
      const isEditable = (target: EventTarget | null): boolean => {
        if (!(target instanceof HTMLElement)) return false
        if (target.isContentEditable) return true
        if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly
        if (target instanceof HTMLInputElement) {
          const type = (target.type || "text").toLowerCase()
          return !NON_TEXT_INPUT_TYPES.has(type) && !target.disabled && !target.readOnly
        }
        return false
      }

      const sendSignal = (message: MobileKeyboardBridgeMessage) => {
        const fn = (window as unknown as Record<string, unknown>)[exposedSignal]
        if (typeof fn === "function") {
          void (fn as (payload: MobileKeyboardBridgeMessage) => Promise<void>)(message).catch(() => {})
        }
      }

      let active = true
      let inset = 0
      let insetAnimating = false
      let insetGen = 0

      if (initMode === "inset") {
        const win = window as unknown as Record<string, unknown>
        if (!("__TAURI__" in win)) {
          Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
        }
        const existingWebkit = (win.webkit as Record<string, unknown> | undefined) ?? {}
        const existingHandlers = (existingWebkit.messageHandlers as Record<string, unknown> | undefined) ?? {}
        Object.defineProperty(window, "webkit", {
          configurable: true,
          value: {
            ...existingWebkit,
            messageHandlers: {
              ...existingHandlers,
              alookKeyboard: {
                postMessage: async () => ({
                  bottomInset: inset,
                  viewportWidth: initWidth,
                  isAnimating: insetAnimating,
                }),
              },
            },
          },
        })
      }

      const runInsetAnimation = (targetState: MobileKeyboardState) => {
        const targetInset = targetState === "open" ? initInsetHeight : 0
        const gen = ++insetGen
        const startInset = inset
        insetAnimating = true
        sendSignal({ kind: "focus-change", state: targetState })

        const stepFrame = (step: number) => {
          if (!active || gen !== insetGen) return
          const isFinal = step >= initSteps
          inset = isFinal
            ? targetInset
            : Math.round(startInset + ((targetInset - startInset) * step) / initSteps)
          insetAnimating = !isFinal
          window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
            detail: {
              bottomInset: inset,
              viewportWidth: initWidth,
              isAnimating: insetAnimating,
            },
          }))
          if (isFinal) {
            sendSignal({ kind: "inset-settled", state: targetState, bottomInset: inset })
          } else {
            window.requestAnimationFrame(() => stepFrame(step + 1))
          }
        }

        if (initInitialDelayMs > 0) {
          window.setTimeout(() => {
            if (active && gen === insetGen) {
              window.requestAnimationFrame(() => stepFrame(1))
            }
          }, initInitialDelayMs)
        } else {
          window.requestAnimationFrame(() => stepFrame(1))
        }
      }

      const onFocusIn = (event: FocusEvent) => {
        if (!active || !isEditable(event.target)) return
        if (initMode === "inset") {
          runInsetAnimation("open")
        } else {
          sendSignal({ kind: "focus-change", state: "open" })
        }
      }

      const onFocusOut = (event: FocusEvent) => {
        if (!active || !isEditable(event.target) || isEditable(event.relatedTarget)) return
        if (initMode === "inset") {
          runInsetAnimation("closed")
        } else {
          sendSignal({ kind: "focus-change", state: "closed" })
        }
      }

      document.addEventListener("focusin", onFocusIn, true)
      document.addEventListener("focusout", onFocusOut, true)

      ;(window as unknown as Record<string, unknown>)[exposedDrive] = (action: "open" | "closed" | "dispose") => {
        if (action === "dispose") {
          active = false
          insetGen += 1
          document.removeEventListener("focusin", onFocusIn, true)
          document.removeEventListener("focusout", onFocusOut, true)
          return
        }
        if (initMode === "inset") {
          runInsetAnimation(action)
        }
      }
    },
    {
      signalName,
      driveName,
      mode,
      width,
      insetHeight,
      steps,
      initialDelayMs,
    },
  )

  const waitForState = async (targetState: MobileKeyboardState, timeoutMs = 10_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!disposed && (animating || currentState !== targetState)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for mobile keyboard state "${targetState}" (current="${currentState}", animating=${animating})`)
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(done)
          resolve()
        }, Math.min(remaining, 100))
        const done = () => {
          clearTimeout(timer)
          waiters.delete(done)
          resolve()
        }
        waiters.add(done)
      })
    }
    if (mode === "viewport" && !page.isClosed()) {
      const expectedHeight = targetState === "open" ? openHeight : closedHeight
      await expect.poll(() => page.viewportSize()?.height, { timeout: timeoutMs }).toBe(expectedHeight)
    }
  }

  return {
    async open() {
      if (disposed) return
      if (mode === "viewport") {
        await runViewportTransition("open")
        return
      }
      await page.evaluate((fnName) => {
        const fn = (window as unknown as Record<string, unknown>)[fnName]
        if (typeof fn === "function") (fn as (action: "open") => void)("open")
      }, driveName)
      await waitForState("open")
    },
    async close() {
      if (disposed) return
      if (mode === "viewport") {
        await runViewportTransition("closed")
        return
      }
      await page.evaluate((fnName) => {
        const fn = (window as unknown as Record<string, unknown>)[fnName]
        if (typeof fn === "function") (fn as (action: "closed") => void)("closed")
      }, driveName)
      await waitForState("closed")
    },
    waitForState,
    getState: () => ({
      mode,
      state: currentState,
      height: currentHeight,
      bottomInset: currentInset,
      transitions,
    }),
    async dispose() {
      disposed = true
      generation += 1
      animating = false
      notifyWaiters()
      if (!page.isClosed()) {
        await page.evaluate((fnName) => {
          const fn = (window as unknown as Record<string, unknown>)[fnName]
          if (typeof fn === "function") (fn as (action: "dispose") => void)("dispose")
        }, driveName).catch(() => {})
      }
    },
  }
}
