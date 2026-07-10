"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  type AvatarConfig,
  type AvatarDraft,
  BotAvatarPickerDialog,
  isPhotoAvatarUrl,
  serializeAvatarConfig,
} from "@/components/avatar"
import { useUpdateBot, useUploadBotAvatar, type BotSummary } from "@/hooks/community/use-bots"
import {
  COMMUNITY_BOT_NAME_MAX,
  COMMUNITY_BOT_DESCRIPTION_MAX,
} from "@alook/shared"

const DEFAULT_AVATAR: AvatarConfig = {
  shape: "circle",
  eye: "dots",
  nose: "dot",
  bg: 0,
}

export function EditBotDialog({
  bot,
  open,
  onOpenChange,
}: {
  bot: BotSummary
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState(bot.name)
  const [description, setDescription] = useState(bot.description ?? "")
  const [avatarDraft, setAvatarDraft] = useState<AvatarDraft>(() =>
    isPhotoAvatarUrl(bot.image)
      ? { kind: "photo", file: null, previewUrl: bot.image! }
      : { kind: "procedural", image: bot.image ?? serializeAvatarConfig(DEFAULT_AVATAR) },
  )
  const update = useUpdateBot()
  const uploadBotAvatar = useUploadBotAvatar()

  async function submit() {
    if (!name.trim()) return toast.error("name is required")
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
        } catch {
          avatarFailed = true
          toast.error("Bot updated, but the avatar photo failed to upload")
        }
      }
      if (!avatarFailed) toast.success("Bot updated")
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {bot.name}</DialogTitle>
          <DialogDescription>
            Name and description edits take effect on the bot&apos;s next wake trigger.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-center">
            <BotAvatarPickerDialog
              image={avatarDraft.kind === "procedural" ? avatarDraft.image : avatarDraft.previewUrl}
              onChange={setAvatarDraft}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bot-name">Name</Label>
            <Input
              id="bot-name"
              value={name}
              maxLength={COMMUNITY_BOT_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bot-description">Description</Label>
            <Textarea
              id="bot-description"
              rows={3}
              maxLength={COMMUNITY_BOT_DESCRIPTION_MAX}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A helpful research assistant"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
