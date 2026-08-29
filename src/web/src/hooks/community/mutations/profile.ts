"use client"

import { useMutation } from "@tanstack/react-query"
import { apiFetch, readUploadError } from "@/lib/api/client"

export type UpdateProfileArgs = {
  name?: string
  aboutMe?: string
  statusEmoji?: string | null
  statusText?: string | null
}

export type UpdateProfileResult = {
  id: string
  name: string
  discriminator: string
  avatar: string
  avatarVersion: number
  aboutMe: string
  bannerColor: string | null
  statusEmoji: string | null
  statusText: string | null
}

/**
 * PATCH the current user's profile card. The shell applies the canonical
 * response to the global profile map without rewriting query data.
 */
export function useUpdateProfile() {
  return useMutation<UpdateProfileResult, Error, UpdateProfileArgs>({
    mutationFn: (patch) =>
      apiFetch<UpdateProfileResult>("/api/community/users/me/profile", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
  })
}

export type UploadUserAvatarArgs = { file: File }
export type UploadUserAvatarResult = { url: string; avatarVersion: number }

/**
 * Uploads the current user's avatar. Mirrors `useUploadServerIcon`'s raw
 * `fetch`-with-`FormData` pattern. The shell applies the versioned result to
 * the global profile map.
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
