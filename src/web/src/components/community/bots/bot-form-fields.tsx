"use client"

import { Dices } from "lucide-react"
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea"
import { type AvatarDraft, BotAvatarPickerDialog } from "@/components/avatar"
import {
  COMMUNITY_BOT_NAME_MAX,
  COMMUNITY_BOT_DESCRIPTION_MAX,
} from "@alook/shared"

/**
 * Shared Name/Description/Avatar block for the bot create and edit sheets —
 * the frameless treatment mirrors `agent-form-fields.tsx`'s `GeneralFields`
 * (large borderless name input, auto-growing borderless description) so a
 * bot's identity fields read the same way an agent's do, instead of the two
 * bot forms drifting from each other with their own one-off `Input`/`Textarea`
 * styling.
 */
export function BotFormFields({
  avatarDraft,
  onAvatarChange,
  name,
  setName,
  onShuffle,
  description,
  setDescription,
  nameError,
}: {
  avatarDraft: AvatarDraft
  onAvatarChange: (draft: AvatarDraft) => void
  name: string
  setName: (v: string) => void
  onShuffle: () => void
  description: string
  setDescription: (v: string) => void
  nameError?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-center pb-3">
        <BotAvatarPickerDialog
          image={avatarDraft.kind === "procedural" ? avatarDraft.image : avatarDraft.previewUrl}
          onChange={onAvatarChange}
        />
      </div>

      {/* Name — large frameless input, matching #agent-name */}
      <div>
        <div className="relative">
          <input
            id="bot-name"
            value={name}
            maxLength={COMMUNITY_BOT_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name your bot"
            autoFocus
            aria-invalid={Boolean(nameError)}
            aria-describedby={nameError ? "bot-name-error" : undefined}
            className="w-full border-0 bg-transparent px-0 py-1 text-2xl font-medium leading-[1.2] tracking-tight shadow-none outline-none placeholder:text-muted-foreground/40 placeholder:font-normal focus-visible:ring-0"
          />
          <button
            type="button"
            onClick={onShuffle}
            aria-label="Randomize name"
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded p-2 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground"
          >
            <Dices className="size-4" />
          </button>
        </div>
        {nameError && (
          <p id="bot-name-error" className="mt-1 text-xs text-destructive">
            {nameError}
          </p>
        )}
      </div>

      {/* Description — frameless, auto-growing */}
      <AutoResizeTextarea
        id="bot-description"
        value={description}
        maxLength={COMMUNITY_BOT_DESCRIPTION_MAX}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What is this bot for?"
        rows={1}
        className="w-full border-0 bg-transparent px-0 py-1 text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0"
      />
    </div>
  )
}
