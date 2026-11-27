const MAX_ACTIVATIONS_PER_DRAIN = 32

export function createNotificationActivationDrain<
  Activation extends { notificationId: string; viewerUserId?: string | null },
>(deps: {
  peek: () => Promise<Activation | null>
  ack?: (notificationId: string) => Promise<void>
  expectedViewerUserId?: string
  hrefFor: (activation: Activation) => string
  targetIdFor?: (activation: Activation) => string | undefined
  queueDismiss: (notificationId: string, href: string, targetId?: string) => void
  navigate: (href: string) => void
}) {
  let disposed = false
  let draining = false
  let rerun = false
  async function drain() {
    if (disposed) return
    if (draining) { rerun = true; return }
    draining = true
    try {
      do {
        rerun = false
        const seen = new Set<string>()
        for (let step = 0; step < MAX_ACTIVATIONS_PER_DRAIN && !disposed; step++) {
          let activation: Activation | null
          try { activation = await deps.peek() }
          catch { break }
          if (!activation || disposed) break
          if (seen.has(activation.notificationId)) break
          seen.add(activation.notificationId)

          if (
            deps.expectedViewerUserId
            && activation.viewerUserId
            && activation.viewerUserId !== deps.expectedViewerUserId
          ) {
            if (!deps.ack) break
            try { await deps.ack(activation.notificationId) }
            catch { break }
            continue
          }

          const href = deps.hrefFor(activation)
          const targetId = deps.targetIdFor?.(activation)
          try { deps.queueDismiss(activation.notificationId, href, targetId) }
          catch { /* Activation navigation survives unavailable dismissal storage. */ }
          if (disposed) break
          deps.navigate(href)
          if (!deps.ack) break
          try { await deps.ack(activation.notificationId) }
          catch { break }
        }
      } while (rerun && !disposed)
    } finally { draining = false }
  }
  return { drain, dispose: () => { disposed = true }, get disposed() { return disposed } }
}
