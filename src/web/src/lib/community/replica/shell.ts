const COMMUNITY_SHELL_SCRIPT = "/sw.js"
const COMMUNITY_SHELL_SCOPE = "/"
const COMMUNITY_SHELL_TIMEOUT_MS = 15_000
const COMMUNITY_SHELL_PROTOCOL_VERSION = 1 as const

type ShellReply = {
  ok: boolean
  protocolVersion?: number
  route?: string
  assets?: number
  error?: string
}

function canUseCommunityShell(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "MessageChannel" in window
}

async function sendShellCommand(
  worker: ServiceWorker,
  message: { type: "CACHE_COMMUNITY_ROUTE"; protocolVersion: number; url: string } | { type: "CLEAR_COMMUNITY_ROUTES" },
): Promise<ShellReply> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timeout = window.setTimeout(() => resolve({ ok: false, error: "timeout" }), COMMUNITY_SHELL_TIMEOUT_MS)
    channel.port1.onmessage = (event: MessageEvent<ShellReply>) => {
      window.clearTimeout(timeout)
      resolve(event.data)
    }
    worker.postMessage(message, [channel.port2])
  })
}

async function activeCommunityWorker(): Promise<ServiceWorker | null> {
  if (!canUseCommunityShell()) return null
  const registration = await navigator.serviceWorker.register(COMMUNITY_SHELL_SCRIPT, {
    scope: COMMUNITY_SHELL_SCOPE,
    updateViaCache: "none",
  })
  const ready = await navigator.serviceWorker.ready
  return ready.active ?? registration.active ?? null
}

export async function cacheCommunityShellRoute(url: string): Promise<ShellReply> {
  const worker = await activeCommunityWorker()
  if (!worker) return { ok: false, error: "unsupported" }
  return sendShellCommand(worker, {
    type: "CACHE_COMMUNITY_ROUTE",
    protocolVersion: COMMUNITY_SHELL_PROTOCOL_VERSION,
    url,
  })
}

export async function clearCommunityShellRoutes(): Promise<void> {
  if (!canUseCommunityShell()) return
  const registration = await navigator.serviceWorker.getRegistration(COMMUNITY_SHELL_SCOPE)
  const worker = registration?.active ?? navigator.serviceWorker.controller
  if (!worker) return
  await sendShellCommand(worker, { type: "CLEAR_COMMUNITY_ROUTES" })
}
