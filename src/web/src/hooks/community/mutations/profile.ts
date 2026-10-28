"use client"

import { parseCommunitySelfProfileRead, type CommunitySelfProfileRead } from "@alook/shared"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback } from "react"

import { useCommunityMutationOrigin } from "../community-origin"
import { useMutation } from "@tanstack/react-query"
import { beginCommunityProfileSeed, writeCommunityProfilePatches } from "@/lib/community/profile-seed"

type OriginalView = (() => void) & { signal: AbortSignal }

export type UpdateProfileArgs = {
  assertActive?: OriginalView
  name?: string
  aboutMe?: string
  statusEmoji?: string | null
  statusText?: string | null
}

export type UpdateProfileResult = CommunitySelfProfileRead

/**
 * PATCH the current user's profile card. The shell applies the canonical
 * response to the global profile map without rewriting query data.
 */
export function useUpdateProfile() {
  const origin = useCommunityMutationOrigin()
  type Intent = UpdateProfileArgs & { original: ReturnType<typeof origin.begin>["token"] }
  const native = useMutation<UpdateProfileResult, Error, Intent>({ meta: { observabilityAction: "profile.update" },
    mutationKey: ["community", "profile-command"], scope: { id: "community-profile-command" }, gcTime: 0,
    mutationFn: async ({ original, assertActive, ...patch }) => {
      origin.assert(original); assertActive?.()
      const snapshot = beginCommunityProfileSeed(origin.registry)
      const profile = parseCommunitySelfProfileRead(await origin.request<unknown>(original, "/api/community/users/me/profile", { method: "PATCH", body: JSON.stringify(patch), signal: assertActive?.signal, assertActive }), original.viewerId!)
      origin.assert(original); assertActive?.()
      writeCommunityProfilePatches([{
        id: profile.id,
        ...(patch.name !== undefined || patch.aboutMe !== undefined ? { identityAbout: { ...(patch.name === undefined ? {} : { name: profile.name }), ...(patch.aboutMe === undefined ? {} : { aboutMe: profile.aboutMe }) } } : {}),
        ...(patch.statusEmoji !== undefined || patch.statusText !== undefined ? { status: { ...(patch.statusEmoji === undefined ? {} : { statusEmoji: profile.statusEmoji }), ...(patch.statusText === undefined ? {} : { statusText: profile.statusText }) } } : {}),
      }], snapshot.registry, { snapshot, command: true })
      return profile
    },
  })
  const capture = useCallback((input: UpdateProfileArgs): Intent => { input.assertActive?.(); return { ...input, original: origin.begin().token } }, [origin])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}

export type UploadUserAvatarArgs = { file: File; assertActive?: OriginalView }
export type UploadUserAvatarResult = { url: string; avatarVersion: number }

/**
 * Uploads the current user's avatar. Mirrors `useUploadServerIcon`'s raw
 * `fetch`-with-`FormData` pattern. The shell applies the versioned result to
 * the global profile map.
 */
export function useUploadUserAvatar() {
  const origin = useCommunityMutationOrigin()
  type Intent = UploadUserAvatarArgs & { original: ReturnType<typeof origin.begin>["token"] }
  const native = useMutation<UploadUserAvatarResult, Error, Intent>({ meta: { observabilityAction: "profile.avatar.upload" },
    mutationKey: ["community", "profile-avatar-command"], scope: { id: "community-profile-command" }, gcTime: 0,
    mutationFn: async ({ file, original, assertActive }) => {
      origin.assert(original); assertActive?.()
      const snapshot = beginCommunityProfileSeed(origin.registry)
      const formData = new FormData()
      formData.append("file", file)
      const data = await origin.request<UploadUserAvatarResult>(original, "/api/community/users/me/avatar", { method: "POST", body: formData, signal: assertActive?.signal, assertActive })
      origin.assert(original); assertActive?.()
      if (original.viewerId) writeCommunityProfilePatches([{ id: original.viewerId, avatar: { avatar: data.url, avatarVersion: data.avatarVersion } }], snapshot.registry, { snapshot, command: true })
      return data
    },
  })
  const capture = useCallback((input: UploadUserAvatarArgs): Intent => { input.assertActive?.(); return { ...input, original: origin.begin().token } }, [origin])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}
