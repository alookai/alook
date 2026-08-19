import {
  encodeCommunityBrowserEvent,
  isCommunityEventCandidate,
} from "@alook/shared"

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

export function createInternalCommunityUserBroadcastRequest(
  targetUserId: string,
  body: BodyInit | null,
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    [INTERNAL_USER_TARGET_HEADER]: encodeURIComponent(targetUserId),
  })
  return new Request("http://internal/community-broadcast", {
    method: "POST",
    headers,
    body,
  })
}

export function createInternalCommunityUserBundleRequest(
  targetUserId: string,
  events: readonly unknown[],
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    [INTERNAL_USER_TARGET_HEADER]: encodeURIComponent(targetUserId),
  })
  return new Request("http://internal/community-broadcast-bundle", {
    method: "POST",
    headers,
    body: JSON.stringify({ events }),
  })
}

export function createInternalBrowserBroadcastRequest(
  targetUserId: string,
  payload: unknown,
): Request {
  if (isCommunityEventCandidate(payload)) {
    const encoded = encodeCommunityBrowserEvent(payload)
    if (!encoded.ok) throw new Error(`invalid community event: ${encoded.reason}`)
    return createInternalCommunityUserBroadcastRequest(targetUserId, encoded.body)
  }
  return createInternalUserBroadcastRequest(targetUserId, JSON.stringify(payload))
}

export function getInternalUserTarget(request: Request): string | null {
  const targetUserId = request.headers.get(INTERNAL_USER_TARGET_HEADER)?.trim()
  return targetUserId || null
}

export function getInternalCommunityUserTarget(request: Request): string | null {
  const encoded = request.headers.get(INTERNAL_USER_TARGET_HEADER)?.trim()
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}
