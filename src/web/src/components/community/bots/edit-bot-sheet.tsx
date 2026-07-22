"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import {
  type AvatarDraft,
  isPhotoAvatarUrl,
} from "@/components/avatar"
import { serializeBeamSeed, parseBeamSeed } from "@/lib/avatar/seed-url"
import { useUpdateBot, useUploadBotAvatar, type BotSummary } from "@/hooks/community/use-bots"
import { BotFormFields } from "./bot-form-fields"
import { uniqueNamesGenerator, names } from "unique-names-generator"

function draftFromBot(bot: BotSummary): AvatarDraft {
  if (isPhotoAvatarUrl(bot.image)) return { kind: "photo", file: null, previewUrl: bot.image! }
  // A stored beam seed persists; a legacy `avatar:{shape…}` config or null
  // falls back to a beam seeded by the bot id.
  return { kind: "procedural", image: parseBeamSeed(bot.image) ? bot.image! : serializeBeamSeed(bot.id) }
}

export function EditBotSheet({
  bot,
  open,
  onOpenChange,
}: {
  // Nullable — the caller (`bot-list.tsx`) keeps this sheet mounted at all
  // times so the open/close transition always has a "closed" state to
  // animate from (mounting it fresh already-open, like the old
  // `{editing && <EditBotSheet .../>}` gate did, skips the enter animation
  // entirely). `bot` is only null before the first-ever edit.
  bot: BotSummary | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState(bot?.name ?? "")
  const [description, setDescription] = useState(bot?.description ?? "")
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [avatarDraft, setAvatarDraft] = useState<AvatarDraft>(() =>
    bot ? draftFromBot(bot) : { kind: "procedural", image: serializeBeamSeed("initial") },
  )
  const update = useUpdateBot()
  const uploadBotAvatar = useUploadBotAvatar()

  // Re-sync the form fields from `bot` each time a *new* edit target opens
  // (keyed by id, not by every `bot` reference change — the parent's
  // `editingBot` never resets to null, so this only re-fires when the user
  // actually picks a different bot to edit).
  const syncedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open || !bot) return
    if (syncedForRef.current === bot.id) return
    syncedForRef.current = bot.id
    setName(bot.name)
    setDescription(bot.description ?? "")
    setAvatarDraft(draftFromBot(bot))
    setNameError(undefined)
  }, [open, bot])

  function updateName(value: string) {
    setName(value)
    if (nameError && value.trim()) setNameError(undefined)
  }

  function shuffleName() {
    setName(uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "capital" }))
    setNameError(undefined)
  }

  async function submit() {
    if (!bot) return
    if (!name.trim()) {
      setNameError("Name is required")
      return
    }
    try {
      // Sequence matters — only attempt the avatar upload AFTER the
      // name/description update resolves, inside the same try block, so a
      // failed field update never triggers an upload.
      await update.mutateAsync({
        id: bot.id,
        name: name.trim(),
        description: description.trim() || undefined,
        image: avatarDraft.kind === "procedural" ? avatarDraft.image : undefined,
      })
      let avatarFailed = false
      if (avatarDraft.kind === "photo" && avatarDraft.file) {
        try {
          await uploadBotAvatar.mutateAsync({ botId: bot.id, file: avatarDraft.file })
        } catch (e) {
          avatarFailed = true
          toastApiError(e, "Bot updated, but the avatar photo failed to upload")
        }
      }
      if (!avatarFailed) toast.success("Bot updated")
      onOpenChange(false)
    } catch (e) {
      toastApiError(e, "Update failed")
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <SheetContent
        side="right"
        showOverlay={false}
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border data-[side=right]:sm:overflow-hidden"
      >
        <SheetHeader>
          <SheetTitle>Edit {bot?.name ?? "bot"}</SheetTitle>
          <SheetDescription>
            Name and description edits take effect on the bot&apos;s next wake trigger.
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
          <BotFormFields
            avatarDraft={avatarDraft}
            onAvatarChange={setAvatarDraft}
            name={name}
            setName={updateName}
            onShuffle={shuffleName}
            description={description}
            setDescription={setDescription}
            nameError={nameError}
          />
        </SheetBody>

        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={update.isPending || !bot}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
