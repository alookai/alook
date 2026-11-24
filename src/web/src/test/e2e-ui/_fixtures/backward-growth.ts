type Measurement = { at: number; height: number; direction: string | null; lastInputAt: number; inputDelta: number }
type Receipt = { id: string; top: number; growingBottom: number; rowHeight: number; at: number; inputDelta: number; measurement: Measurement | null }
type Session = { receipt: Receipt; stop: () => void }
type FixtureElement = HTMLElement & { __backwardGrowth?: Session }

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
  const growing = root.querySelector<HTMLElement>(`[data-msg-id="${command.start}"]`)
  const wrapper = growing?.closest<HTMLElement>("[data-index]")
  const top = root.getBoundingClientRect().top
  const reader = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
    .find(row => row.getBoundingClientRect().bottom > top + 1)
  if (!wrapper || !reader) throw new Error("Mounted growing and reading rows are required")
  const receipt: Receipt = {
    id: reader.dataset.msgId!,
    top: reader.getBoundingClientRect().top - top,
    growingBottom: wrapper.getBoundingClientRect().bottom - top,
    rowHeight: wrapper.getBoundingClientRect().height,
    at: performance.now(),
    inputDelta: 0,
    measurement: null,
  }
  let frame = 0
  let lastInputAt = receipt.at
  let stopped = false
  let observer: ResizeObserver | null = null
  const stop = () => {
    stopped = true
    cancelAnimationFrame(frame)
    observer?.disconnect()
    observer = null
  }
  observer = new ResizeObserver(() => {
    const nextHeight = wrapper.getBoundingClientRect().height
    if (nextHeight > receipt.rowHeight + 1 && !receipt.measurement) {
      receipt.measurement = {
        at: performance.now(),
        height: nextHeight,
        direction: "backward",
        lastInputAt,
        inputDelta: receipt.inputDelta,
      }
      stop()
    }
  })
  observer.observe(wrapper)
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
