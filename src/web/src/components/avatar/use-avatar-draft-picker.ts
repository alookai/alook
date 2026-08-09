"use client"

import { useCallback, useEffect, useState } from "react"
import { isPhotoAvatarUrl, type AvatarDraft } from "@/lib/avatar/model"
import { parseBeamSeed, serializeBeamSeed } from "@/lib/avatar/seed-url"

export type AvatarPickerTab = "generate" | "photo"
export type PhotoAvatarDraft = { file: File | null; previewUrl: string }

export interface AvatarPickerState {
  tab: AvatarPickerTab
  seed: string
  photoDraft: PhotoAvatarDraft | null
  activeKind: AvatarDraft["kind"]
}

export function isPhotoDraftSource(value: string | null | undefined): value is string {
  return !!value && !parseBeamSeed(value) && (isPhotoAvatarUrl(value) || value.startsWith("blob:"))
}

export function avatarPickerStateFromImage(image: string | null, fallbackSeed: string): AvatarPickerState {
  const photo = isPhotoDraftSource(image)
  return {
    tab: (photo ? "photo" : "generate") as AvatarPickerTab,
    seed: parseBeamSeed(image) ?? fallbackSeed,
    photoDraft: photo ? { file: null, previewUrl: image } satisfies PhotoAvatarDraft : null,
    activeKind: (photo ? "photo" : "procedural") as AvatarDraft["kind"],
  }
}

function randomSeed(): string {
  return crypto.randomUUID()
}

export function useAvatarDraftPicker(image: string | null, onChange: (draft: AvatarDraft) => void) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState(() => avatarPickerStateFromImage(image, randomSeed()))

  const syncFromImage = useCallback((value: string | null, resetTab: boolean) => {
    const next = avatarPickerStateFromImage(value, randomSeed())
    setState((current) => ({
      ...next,
      tab: resetTab ? next.tab : current.tab,
      photoDraft:
        next.photoDraft && current.photoDraft?.previewUrl === next.photoDraft.previewUrl
          ? current.photoDraft
          : next.photoDraft,
    }))
  }, [])

  useEffect(() => {
    syncFromImage(image, false)
  }, [image, syncFromImage])

  const onOpenChange = (nextOpen: boolean) => {
    if (nextOpen) syncFromImage(image, true)
    setOpen(nextOpen)
  }

  const selectTab = (nextTab: AvatarPickerTab) => {
    if (nextTab === "photo" && state.photoDraft) {
      setState((current) => ({ ...current, tab: nextTab, activeKind: "photo" }))
      onChange({ kind: "photo", file: state.photoDraft.file, previewUrl: state.photoDraft.previewUrl })
      return
    }
    setState((current) => ({ ...current, tab: nextTab, activeKind: "procedural" }))
    onChange({ kind: "procedural", image: serializeBeamSeed(state.seed) })
  }

  const shuffle = () => {
    const nextSeed = randomSeed()
    setState((current) => ({ ...current, seed: nextSeed, activeKind: "procedural" }))
    onChange({ kind: "procedural", image: serializeBeamSeed(nextSeed) })
  }

  const selectPhoto = (photo: PhotoAvatarDraft) => {
    setState((current) => ({ ...current, photoDraft: photo, activeKind: "photo" }))
    onChange({ kind: "photo", file: photo.file, previewUrl: photo.previewUrl })
  }

  return {
    ...state,
    close: () => setOpen(false),
    onOpenChange,
    open,
    selectPhoto,
    selectTab,
    shuffle,
  }
}
