"use client"

import { toast } from "sonner"
import type { FriendApprovalPayload } from "@alook/shared"
import { useOwnerDecision } from "@/hooks/community/mutations/friends"
import { Button } from "@/components/ui/button"
import { ProfileAvatar } from "@/components/avatar"
import { useCommunityProfile } from "@/stores/community/ws"
import { readCommunityProfile } from "@/lib/community/profile-read"

/**
 * Inline friend-approval card, rendered in a bot owner's DM with their bot when
 * a message carries an `approval` payload. States are driven by the per-viewer
 * projection (`status` × `waitingOn`) — see
 * plans/agent-friendship-approval-gate.md §UI. Only the actionable state
 * (`pending, waitingOn='you'`) shows Approve/Deny; everything else is a chip.
 */
export function BotApprovalCard({ approval }: { approval: FriendApprovalPayload }) {
  const decide = useOwnerDecision()
  const { status, waitingOn, otherProfile, botProfile, waitingOnProfile } = approval
  const other = readCommunityProfile(
    useCommunityProfile(otherProfile.id),
    otherProfile.id,
  )
  const bot = readCommunityProfile(
    useCommunityProfile(botProfile.id),
    botProfile.id,
  )
  const waiting = readCommunityProfile(
    useCommunityProfile(waitingOnProfile?.id),
    waitingOnProfile?.id ?? "",
  )
  const otherHandle = `${other.name}#${other.discriminator}`

  const onDecide = async (decision: "approve" | "deny") => {
    try {
      await decide.mutateAsync({ friendshipId: approval.friendshipId, decision })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't record your decision — try again"
      toast(msg)
    }
  }

  const cardBase =
    "flex max-w-100 flex-col gap-3 rounded-md border border-border bg-card p-3"

  // Header — who wants to friend whom. Symmetric wording; no isBot leak.
  const header = (
    <div className="flex items-center gap-3">
      <ProfileAvatar
        label={other.name}
        seed={other.id}
        src={other.avatar}
        size={40}
        data-testid="bot-approval-avatar"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{otherHandle}</div>
        <div className="text-xs text-muted-foreground">
          {other.name} wants to be friends with {bot.name}.
        </div>
      </div>
    </div>
  )

  // Chip states — non-actionable.
  const chip = (label: string, dim = false) => (
    <div className={cardBase} data-testid="bot-approval-card" data-approval-status={status}>
      {header}
      <div className={`text-xs font-medium ${dim ? "text-muted-foreground italic" : "text-muted-foreground"}`}>
        {label}
      </div>
    </div>
  )

  if (status === "approved") return chip("Approved")
  if (status === "denied") return chip("Denied")
  if (status === "superseded") return chip("Replaced by a newer request", true)
  if (status === "cancelled") return chip(`${other.name} withdrew the request`, true)

  // status === "pending"
  if (waitingOn === "addressee" || waitingOn === "other-owner") {
    const name = waitingOnProfile ? waiting.name : "them"
    return chip(`Approved — waiting on ${name}`)
  }

  // waitingOn === "you" — actionable.
  return (
    <div className={cardBase} data-testid="bot-approval-card" data-approval-status={status}>
      {header}
      <div className="flex gap-2">
        <Button
          size="sm"
          className="h-11 flex-1 sm:h-9"
          onClick={() => onDecide("approve")}
          disabled={decide.isPending}
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="h-11 flex-1 sm:h-9"
          onClick={() => onDecide("deny")}
          disabled={decide.isPending}
        >
          Deny
        </Button>
      </div>
    </div>
  )
}
