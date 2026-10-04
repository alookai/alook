export const CONVERSATION_READ_TIMEOUT_MS = 15_000

export class ConversationReadTimeoutError extends Error {
  constructor() {
    super("Conversation read timed out")
    this.name = "ConversationReadTimeoutError"
  }
}

export function isConversationAccessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && [401, 403, 404].includes(Number(error.status))
}

export function retryConversationRead(failureCount: number, error: Error): boolean {
  return !(error instanceof ConversationReadTimeoutError)
    && error.name !== "AbortError"
    && !isConversationAccessError(error)
    && failureCount < 1
}

export async function withConversationReadDeadline<T>(
  signal: AbortSignal | undefined,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const readSignal = signal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let rejectAborted!: (error: unknown) => void
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject })
  const cancel = (reason: unknown) => {
    controller.abort(reason)
    rejectAborted(reason)
  }
  const onAbort = () => cancel(signal?.reason ?? new DOMException("Retired conversation read", "AbortError"))
  signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => cancel(new ConversationReadTimeoutError()), CONVERSATION_READ_TIMEOUT_MS)
  try {
    if (signal?.aborted) onAbort()
    if (readSignal.aborted) return await aborted
    const result = await Promise.race([read(readSignal), aborted])
    controller.signal.throwIfAborted()
    return result
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

export function conversationReadRetryPolicy(
  policy: boolean | number | ((failureCount: number, error: Error) => boolean) = 3,
) {
  return (failureCount: number, error: Error): boolean => {
    if (error instanceof ConversationReadTimeoutError || error.name === "AbortError" || isConversationAccessError(error)) return false
    if (typeof policy === "function") return policy(failureCount, error)
    return policy === true || (policy !== false && failureCount < policy)
  }
}
