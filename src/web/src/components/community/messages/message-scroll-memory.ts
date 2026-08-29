const MAX_REMEMBERED_MESSAGE_SCROLLS = 50
const positions = new Map<string, number>()
const activeCaptures = new Map<symbol, () => void>()

export function readMessageScrollPosition(key: string): number | undefined {
  return positions.get(key)
}

export function writeMessageScrollPosition(key: string, scrollTop: number): void {
  positions.delete(key)
  positions.set(key, Math.max(0, scrollTop))
  while (positions.size > MAX_REMEMBERED_MESSAGE_SCROLLS) {
    const oldest = positions.keys().next().value
    if (oldest === undefined) break
    positions.delete(oldest)
  }
}

export function clearMessageScrollPositions(): void {
  positions.clear()
}

export function registerActiveMessageScrollCapture(
  key: string,
  element: HTMLElement,
): () => void {
  const token = Symbol(key)
  activeCaptures.set(token, () => {
    if (element.isConnected && element.clientHeight > 0) {
      writeMessageScrollPosition(key, element.scrollTop)
    }
  })
  return () => activeCaptures.delete(token)
}

export function captureActiveMessageScrollPosition(): void {
  activeCaptures.forEach((capture) => capture())
}
