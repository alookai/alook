/**
 * Is this a transport-transient mutation error worth retrying?
 *
 * Only true for "the request may or may not have reached/committed on the
 * server, but the RESPONSE was lost" shapes: an upstream 5xx wrapper, a body
 * that couldn't be read, or a network-level fetch failure. Callers must make a
 * committed-but-response-lost retry safe: sends/posts reuse one nonce, while
 * property set/remove mutations are database-idempotent.
 *
 * NOT transient (never retried here): business outcomes. `blocked`/unaligned is
 * a RETURN value (handled below, never thrown). 4xx business errors (bad
 * attachment, reply-not-found, forbidden) come back as thrown Errors with the
 * server's message and are deterministic — retrying would just re-fail.
 */
function isTransientMutationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status = typeof err === "object" && err !== null && "status" in err
    ? (err as { status?: unknown }).status
    : undefined;
  return (
    (typeof status === "number" && status >= 500 && status <= 599) ||
    /upstream returned 5\d\d/.test(msg) ||
    msg.includes("upstream body read failed") ||
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("socket hang up") ||
    msg.includes("network")
  );
}

export async function withTransientMutationRetry<T>(mutation: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 4;
  const BASE_DELAY_MS = 150;
  const MAX_DELAY_MS = 2000;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await mutation();
    } catch (err) {
      lastErr = err;
      if (!isTransientMutationError(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, cap));
    }
  }
  throw lastErr;
}

