"use client"

import { useMutation } from "@tanstack/react-query"
import { apiFetch, readUploadError } from "@/lib/api/client"

export type UpdateProfileArgs = {
  name?: string
  aboutMe?: string
  statusEmoji?: string | null
  statusText?: string | null
}

/**
 * PATCH the current user's profile card. Consumers apply the returned payload
 * to their own local user state (the current-user identity lives outside the
 * community query cache).
 */
export function useUpdateProfile() {
  return useMutation<void, Error, UpdateProfileArgs>({
    mutationFn: async (patch) => {
      await apiFetch("/api/community/users/me/profile", {
        method: "PATCH",
        body: JSON.stringify(patch),
      })
    },
  })
}

export type UploadUserAvatarArgs = { file: File }
export type UploadUserAvatarResult = { url: string }

/**
 * Uploads the current user's avatar. Mirrors `useUploadServerIcon`'s raw
 * `fetch`-with-`FormData` pattern. Consumers apply the returned URL to their
 * own local `CurrentUser` state — the identity lives outside the community
 * query cache (see `contexts/community/current-user.tsx`).
 */
export function useUploadUserAvatar() {
  return useMutation<UploadUserAvatarResult, Error, UploadUserAvatarArgs>({
    mutationFn: async ({ file }) => {
      const formData = new FormData()
      formData.append("file", file)
      const res = await fetch("/api/community/users/me/avatar", {
        method: "POST",
        body: formData,
        credentials: "include",
      })
      if (!res.ok) throw await readUploadError(res, "Upload failed")
      return (await res.json()) as UploadUserAvatarResult
    },
  })
}
