export const INTERNAL_USER_TARGET_HEADER = "x-alook-internal-user-target"

export function createInternalUserBroadcastRequest(
  targetUserId: string,
  body: BodyInit | null,
  sourceHeaders?: Headers,
  streamingBody = false,
): Request {
  const headers = new Headers()
  const contentType = sourceHeaders?.get("content-type")
  if (contentType) headers.set("content-type", contentType)
  headers.set(INTERNAL_USER_TARGET_HEADER, targetUserId)

  const init = {
    method: "POST",
    headers,
    body,
  } as RequestInit & { duplex?: "half" }
  if (streamingBody) init.duplex = "half"

  return new Request("http://internal/broadcast", init)
}

export function getInternalUserTarget(request: Request): string | null {
  const targetUserId = request.headers.get(INTERNAL_USER_TARGET_HEADER)?.trim()
  return targetUserId || null
}
