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
    error: "this is a direct message — address it through the canonical channel door (/api/community/channels/[id]/*), which dispatches DM block checks by surface trait.",
  }
}

export function requireMessageBearingSurface(channelType: string | null | undefined): WriteGuardResult {
  const dmGuard = rejectDmOnGenericChannelRoute(channelType)
  if (!dmGuard.ok) return dmGuard
  if (isMessageBearingSurface(channelType)) return pass
  return {
    ok: false,
    status: 400,
    error: "cannot post a message here",
  }
}

export function requireReactableSurface(channelType: string | null | undefined): WriteGuardResult {
  if (isMessageBearingSurface(channelType)) return pass
  return {
    ok: false,
    status: 400,
    error: "nothing to react to here",
  }
}

export function requireChildSurface(channelType: string | null | undefined): WriteGuardResult {
  if (isThread(channelType) || isForumPost(channelType)) return pass
  return { ok: false, status: 400, error: "not a thread or forum post" }
}

export function requirePinnableSurface(channelType: string | null | undefined): WriteGuardResult {
  if (isDm(channelType)) {
    return { ok: false, status: 400, error: "direct messages don't support pinning" }
  }
  if (!isMessageBearingSurface(channelType)) {
    return { ok: false, status: 400, error: "nothing to pin here" }
  }
  return pass
}
