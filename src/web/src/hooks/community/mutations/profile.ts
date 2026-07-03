"use client"

import { useMutation } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"

export type UpdateProfileArgs = {
  name?: string
  aboutMe?: string
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
