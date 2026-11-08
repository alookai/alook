export function createNotificationActivationDrain<Activation extends { notificationId: string }>(deps: {
  take: () => Promise<Activation | null>
  hrefFor: (activation: Activation) => string
  queueDismiss: (notificationId: string, href: string) => void
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
        let activation: Activation | null
        try { activation = await deps.take() }
        catch { continue }
        if (!activation || disposed) continue
        const href = deps.hrefFor(activation)
        try { deps.queueDismiss(activation.notificationId, href) }
        catch { /* Activation navigation survives unavailable dismissal storage. */ }
        if (!disposed) deps.navigate(href)
      } while (rerun && !disposed)
    } finally { draining = false }
  }
  return { drain, dispose: () => { disposed = true }, get disposed() { return disposed } }
}
