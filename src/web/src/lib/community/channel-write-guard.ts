import { isMessageBearingSurface, isThread, isForumPost, isDm } from "@alook/shared"

type GuardOk = { ok: true }
type GuardErr = { ok: false; status: 400; error: string }
export type WriteGuardResult = GuardOk | GuardErr

const pass: GuardOk = { ok: true }

export function rejectDmOnGenericChannelRoute(channelType: string | null | undefined): WriteGuardResult {
  if (!isDm(channelType)) return pass
  return {
    ok: false,
    status: 400,
    error: "this is a direct message — use the DM endpoints (/api/community/dm/[id]/*), which enforce block checks.",
  }
}

export function requireMessageBearingSurface(channelType: string | null | undefined): WriteGuardResult {
  const dmGuard = rejectDmOnGenericChannelRoute(channelType)
  if (!dmGuard.ok) return dmGuard
  if (isMessageBearingSurface(channelType)) return pass
  return {
    ok: false,
    status: 400,
    error: "cannot post a message here — a forum top-level holds posts, not messages. Create a post (a title is required).",
  }
}

export function requireChildSurface(channelType: string | null | undefined): WriteGuardResult {
  if (isThread(channelType) || isForumPost(channelType)) return pass
  return { ok: false, status: 400, error: "not a thread or forum post" }
}
