import type { Virtualizer } from "@tanstack/react-virtual"

type Measurement = { at: number; height: number; direction: string | null; lastInputAt: number; inputDelta: number }
type Receipt = { id: string; top: number; growingBottom: number; rowHeight: number; at: number; inputDelta: number; measurement: Measurement | null }
type Session = { receipt: Receipt; stop: () => void }
type FixtureElement = HTMLElement & { __backwardGrowth?: Session }
type Hook = { memoizedState?: unknown; next?: Hook }
type Fiber = { memoizedState?: Hook; return?: Fiber }

export function controlledBackwardGrowth(element: HTMLElement, command: { start: string } | { finish: true }): Receipt {
  const root = element as FixtureElement
  if ("finish" in command) {
    const session = root.__backwardGrowth
    if (!session) throw new Error("Backward growth session is required")
    session.stop()
    delete root.__backwardGrowth
    return session.receipt
  }
  if (root.__backwardGrowth) throw new Error("Previous backward growth session is still active")
  const fiberKey = Object.keys(root).find(key => key.startsWith("__reactFiber$"))
  let fiber = fiberKey ? (root as unknown as Record<string, Fiber>)[fiberKey] : undefined
  let native: Virtualizer<HTMLElement, Element> | undefined
  for (; fiber && !native; fiber = fiber.return) {
    for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      const value = hook.memoizedState as { current?: unknown } | undefined
      for (const candidate of [value, value?.current]) {
        const instance = candidate as Virtualizer<HTMLElement, Element> | undefined
        if (instance?.scrollElement === root && typeof instance.resizeItem === "function") native = instance
      }
    }
  }
  if (!native) throw new Error("The mounted native virtualizer is required for direction evidence")
  const growing = root.querySelector<HTMLElement>(`[data-msg-id="${command.start}"]`)
  const wrapper = growing?.closest<HTMLElement>("[data-index]")
  const top = root.getBoundingClientRect().top
  const reader = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
    .find(row => row.getBoundingClientRect().bottom > top + 1)
  if (!wrapper || !reader) throw new Error("Mounted growing and reading rows are required")
  const index = Number(wrapper.dataset.index)
  const receipt: Receipt = { id: reader.dataset.msgId!, top: reader.getBoundingClientRect().top - top,
    growingBottom: wrapper.getBoundingClientRect().bottom - top, rowHeight: wrapper.getBoundingClientRect().height,
    at: performance.now(), inputDelta: 0, measurement: null }
  const resizeItem = native.resizeItem
  let frame = 0
  let lastInputAt = receipt.at
  let stopped = false
  const stop = () => {
    stopped = true
    cancelAnimationFrame(frame)
    native.resizeItem = resizeItem
  }
  native.resizeItem = (measuredIndex, height) => {
    if (measuredIndex === index && height > receipt.rowHeight + 1 && !receipt.measurement) {
      receipt.measurement = { at: performance.now(), height, direction: native.scrollDirection, lastInputAt, inputDelta: receipt.inputDelta }
      stop()
    }
    resizeItem(measuredIndex, height)
  }
  const input = () => {
    if (stopped) return
    if (performance.now() - receipt.at > 10_000) { stop(); return }
    root.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
    const before = root.scrollTop
    root.scrollTop -= 1
    receipt.inputDelta += root.scrollTop - before
    root.dispatchEvent(new Event("scroll"))
    lastInputAt = performance.now()
    frame = requestAnimationFrame(input)
  }
  root.__backwardGrowth = { receipt, stop }
  input()
  return { ...receipt }
}

export function cancelControlledBackwardGrowth(element: HTMLElement) {
  const root = element as FixtureElement
  root.__backwardGrowth?.stop()
  delete root.__backwardGrowth
}
