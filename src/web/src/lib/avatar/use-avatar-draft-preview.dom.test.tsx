import { expect, it, vi } from "vitest"
import { renderHook } from "@/test/react-dom-harness"
import { useAvatarDraftPreview } from "./use-avatar-draft-preview"
import type { AvatarDraft } from "./model"

it("releases a retained photo exactly on replacement/reset or final parent unmount", () => {
  const original = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL")
  const revoke = vi.fn()
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: revoke })
  const unmounts: Array<() => void> = []
  try {
  const photo: AvatarDraft = { kind: "photo", file: null, previewUrl: "blob:first" }
  const view = renderHook(({ draft }: { draft: AvatarDraft }) => useAvatarDraftPreview(draft), { initialProps: { draft: photo } as { draft: AvatarDraft } })
  unmounts.push(view.unmount)
  view.rerender({ draft: { ...photo } })
  expect(revoke).not.toHaveBeenCalled()
  view.rerender({ draft: { kind: "photo", file: null, previewUrl: "blob:second" } })
  expect(revoke.mock.calls).toEqual([["blob:first"]])
  view.rerender({ draft: { kind: "procedural", image: "avatar:beam:generated" } })
  expect(revoke.mock.calls).toEqual([["blob:first"], ["blob:second"]])
  view.rerender({ draft: { kind: "photo", file: null, previewUrl: "/avatar/static" } })
  view.unmount()
  expect(revoke).toHaveBeenCalledTimes(2)
  const last = renderHook(() => useAvatarDraftPreview({ kind: "photo", file: null, previewUrl: "blob:last" }))
  unmounts.push(last.unmount)
  last.unmount()
  expect(revoke.mock.calls).toEqual([["blob:first"], ["blob:second"], ["blob:last"]])
  } finally { for (const unmount of unmounts.reverse()) unmount(); if (original) Object.defineProperty(URL, "revokeObjectURL", original); else Reflect.deleteProperty(URL, "revokeObjectURL") }
})
