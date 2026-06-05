"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Trash2, Plus, UserMinus } from "lucide-react";
import { useWorkspace } from "@/contexts/workspace-context";
import { useSession } from "@/lib/auth-client";
import {
  listMembers,
  removeMember,
  listInvites,
  createInvite,
  revokeInvite,
  type MemberEntry,
  type InviteEntry,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { trackTeamMemberInvited } from "@/lib/analytics";

function getInviteLink(token: string) {
  return `${window.location.origin}/invite/${token}`;
}

export function MembersTab() {
  const { workspaceId } = useWorkspace();
  const session = useSession();

  const currentUserId = session.data?.user?.id;

  const [members, setMembers] = useState<MemberEntry[]>([]);
  const [invites, setInvites] = useState<InviteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatingInvite, setGeneratingInvite] = useState(false);

  const isOwner = members.find((m) => m.user_id === currentUserId)?.role === "owner";

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [membersData, invitesData] = await Promise.all([
        listMembers(workspaceId),
        listInvites(workspaceId).catch(() => [] as InviteEntry[]),
      ]);
      setMembers(membersData);
      setInvites(invitesData);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleGenerateInvite = async () => {
    setGeneratingInvite(true);
    try {
      const invite = await createInvite(workspaceId);
      trackTeamMemberInvited({ workspace_id: workspaceId });
      setInvites((prev) => [...prev, invite]);
      const link = getInviteLink(invite.token);
      await navigator.clipboard.writeText(link);
      toast.success("Invite link copied to clipboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate invite");
    } finally {
      setGeneratingInvite(false);
    }
  };

  const handleCopyInvite = async (token: string) => {
    const link = getInviteLink(token);
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Invite link copied");
    } catch {
      toast.error("Failed to copy link");
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    try {
      await revokeInvite(workspaceId, inviteId);
      setInvites((prev) => prev.filter((i) => i.id !== inviteId));
      toast.success("Invite revoked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke invite");
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    try {
      await removeMember(workspaceId, memberId);
      setMembers((prev) => prev.filter((m) => m.id !== memberId));
      toast.success("Member removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove member");
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-4 w-24 mt-6" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Pending invites — owner only */}
      {isOwner && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Pending Invites</h2>
            <Button
              size="sm"
              variant="outline"
              onClick={handleGenerateInvite}
              disabled={generatingInvite}
            >
              <Plus className="size-3.5 mr-1" />
              {generatingInvite ? "Generating…" : "Generate invite link"}
            </Button>
          </div>

          {invites.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              No active invite links. Generate one to invite someone to this workspace.
            </p>
          ) : (
            <div className="space-y-1.5">
              {invites.map((invite) => {
                const expiresAt = new Date(invite.expires_at);
                const isExpired = expiresAt < new Date();
                return (
                  <div
                    key={invite.id}
                    className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <p className={cn("font-mono truncate", isExpired && "text-muted-foreground line-through")}>
                        /invite/{invite.token.slice(0, 12)}…
                      </p>
                      <p className={cn("text-muted-foreground/70 mt-0.5", isExpired && "text-destructive/70")}>
                        {isExpired
                          ? "Expired"
                          : `Expires ${expiresAt.toLocaleDateString()}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 ml-2 shrink-0">
                      {!isExpired && (
                        <Tooltip>
                          <TooltipTrigger render={<Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={() => handleCopyInvite(invite.token)}
                          />}>
                            <Copy className="size-3.5" />
                          </TooltipTrigger>
                          <TooltipContent>Copy invite link</TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger render={<Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                          onClick={() => handleRevokeInvite(invite.id)}
                        />}>
                          <Trash2 className="size-3.5" />
                        </TooltipTrigger>
                        <TooltipContent>Revoke invite</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Member list */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Members</h2>
        <div className="space-y-1.5">
          {members.map((member) => {
            const isSelf = member.user_id === currentUserId;
            const initials = member.name
              ? member.name
                  .split(" ")
                  .map((n) => n[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase()
              : member.email.slice(0, 2).toUpperCase();

            return (
              <div
                key={member.id}
                className="flex items-center gap-3 rounded-md border border-border/50 px-3 py-2"
              >
                {/* Avatar */}
                <div className="size-7 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground shrink-0 overflow-hidden">
                  {member.image ? (
                    <img src={member.image} alt={member.name} className="size-full object-cover" />
                  ) : (
                    initials
                  )}
                </div>

                {/* Name / email */}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate leading-tight">
                    {member.name || member.email}
                    {isSelf && (
                      <span className="ml-1.5 text-xs text-muted-foreground font-normal">(you)</span>
                    )}
                  </p>
                  {member.name && (
                    <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                  )}
                </div>

                {/* Role badge */}
                <span
                  className={cn(
                    "text-xs px-1.5 py-0.5 rounded shrink-0",
                    member.role === "owner"
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {member.role}
                </span>

                {/* Remove button — owner only, not on self */}
                {isOwner && !isSelf && (
                  <Tooltip>
                    <TooltipTrigger render={<Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => handleRemoveMember(member.id)}
                    />}>
                      <UserMinus className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipContent>Remove member</TooltipContent>
                  </Tooltip>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
