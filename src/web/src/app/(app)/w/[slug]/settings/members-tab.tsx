"use client";


import { useQuery, useMutation, type Query } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Trash2, Plus, UserMinus } from "lucide-react";
import { useWorkspaceOwner, captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions } from "@/contexts/workspace-context";
import { workspaceMembersOptions, workspaceInvitesOptions } from "@/hooks/workspace/settings-query-options";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { isAbortError } from "@/lib/errors";
import { removeMember, createInvite, revokeInvite, type MemberEntry, type InviteEntry } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { trackTeamMemberInvited } from "@/lib/analytics";
import { displayName } from "@/lib/community/display-name";
import { ProfileAvatar } from "@/components/avatar";

function getInviteLink(token: string) {
  return `${window.location.origin}/invite/${token}`;
}

export function MembersTab() {
  const owner = useWorkspaceOwner();
  const { workspaceId } = owner;
  const source = useWorkspaceViewSource(owner, "workspace-members", true);
  const currentUserId = owner.application.userId;
  const memberQuery = useQuery(workspaceMembersOptions(owner));
  const members = memberQuery.data ?? [];
  const isOwner = members.find((member) => member.user_id === currentUserId)?.role === "owner";
  const invitesQuery = useQuery({ ...workspaceInvitesOptions(owner), enabled: isOwner, subscribed: isOwner, gcTime: 0 });
  const invites = isOwner ? invitesQuery.data ?? [] : [];
  const loading = memberQuery.isPending || isOwner && invitesQuery.isPending;
  type OriginalIntent = { token: ReturnType<typeof captureWorkspaceOwner>; view: ReturnType<typeof source.capture>; resources: Query[] };
  const native = useMutation({ mutationKey: owner.key("workspace-members-command"), scope: { id: JSON.stringify(owner.key("workspace-members-command")) }, gcTime: 0,
    mutationFn: async ({ action, token, view, resources }: { action: { kind: "create-invite" } | { kind: "revoke-invite" | "remove-member"; id: string }; token: ReturnType<typeof captureWorkspaceOwner> } & OriginalIntent) => {
      const assert = () => { assertWorkspaceOwner(token, view.signal); view.assert(); }, qc = owner.queryClient;
      const key = action.kind === "remove-member" ? workspaceMembersOptions(owner).queryKey : workspaceInvitesOptions(owner).queryKey;
      assert();
      const resource = resources.find((query) => JSON.stringify(query.queryKey) === JSON.stringify(key));
      if (resource && qc.getQueryCache().find({ queryKey: key, exact: true }) === resource) await qc.cancelQueries({ queryKey: key, exact: true });
      assert();
      const writes = resource?.state.dataUpdateCount;
      const qualified = () => resource && qc.getQueryCache().find({ queryKey: key, exact: true }) === resource && resource.state.dataUpdateCount === writes;
      const options = workspaceRequestOptions(token, view.signal, assert);
      let invite: InviteEntry | undefined;
      try {
        if (action.kind === "create-invite") {
          invite = await createInvite(workspaceId, options);
          assert();
          if (qualified()) { const row = invite; qc.setQueryData<InviteEntry[]>(key, (rows) => [...(rows ?? []).filter((entry) => entry.id !== row.id), row]); }
        } else if (action.kind === "revoke-invite") {
          await revokeInvite(workspaceId, action.id, options);
          assert();
          if (qualified()) qc.setQueryData<InviteEntry[]>(key, (rows) => rows?.filter((entry) => entry.id !== action.id));
        } else {
          await removeMember(workspaceId, action.id, options);
          assert();
          if (qualified()) qc.setQueryData<MemberEntry[]>(key, (rows) => rows?.filter((entry) => entry.id !== action.id));
        }
        assert();
        if (resource && qc.getQueryCache().find({ queryKey: key, exact: true }) === resource) await qc.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
        assert();
        return invite;
      } catch (error) { assert(); throw error; }
    },
  });
  const capture = (input: Omit<Parameters<typeof native.mutate>[0], "view" | "resources">) => { const view = source.capture(); view.assert(); assertWorkspaceOwner(input.token, view.signal); return { ...input, view, resources: [...new Set([workspaceMembersOptions(owner).queryKey, workspaceInvitesOptions(owner).queryKey].flatMap((queryKey) => owner.queryClient.getQueryCache().findAll({ queryKey, exact: true })))] }; };
  const command = { ...native, mutate: (input: Omit<Parameters<typeof native.mutate>[0], "view" | "resources">) => native.mutate(capture(input)), mutateAsync: (input: Omit<Parameters<typeof native.mutate>[0], "view" | "resources">) => native.mutateAsync(capture(input)) };
  const generatingInvite = command.isPending && command.variables?.action.kind === "create-invite";
  const handleGenerateInvite = async () => {
    if (owner.queryClient.isMutating({ mutationKey: owner.key("workspace-members-command"), exact: true })) return;
    const assertView = source.capture().assert;
    assertView();
    try {
      const invite = await command.mutateAsync({ action: { kind: "create-invite" }, token: captureWorkspaceOwner(owner) });
      assertView();
      if (!invite) return;
      trackTeamMemberInvited({ workspace_id: workspaceId });
      await navigator.clipboard.writeText(getInviteLink(invite.token));
      assertView();
      toast.success("Invite link copied to clipboard");
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error(error instanceof Error ? error.message : "Failed to generate invite");
    }
  };
  const handleCopyInvite = async (token: string) => {
    const assertView = source.capture().assert;
    assertView();
    try {
      await navigator.clipboard.writeText(getInviteLink(token));
      assertView();
      toast.success("Invite link copied");
    } catch {
      try { assertView(); } catch { return; }
      toast.error("Failed to copy link");
    }
  };
  const handleRevokeInvite = async (id: string) => {
    const assertView = source.capture().assert;
    assertView();
    try {
      await command.mutateAsync({ action: { kind: "revoke-invite", id }, token: captureWorkspaceOwner(owner) });
      assertView();
      toast.success("Invite revoked");
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error(error instanceof Error ? error.message : "Failed to revoke invite");
    }
  };
  const handleRemoveMember = async (id: string) => {
    const assertView = source.capture().assert;
    assertView();
    try {
      await command.mutateAsync({ action: { kind: "remove-member", id }, token: captureWorkspaceOwner(owner) });
      assertView();
      toast.success("Member removed");
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error(error instanceof Error ? error.message : "Failed to remove member");
    }
  };


  if (memberQuery.isError || isOwner && invitesQuery.isError) {
    return <div role="alert" className="space-y-3"><p className="text-sm text-destructive">Could not load workspace members.</p><Button size="sm" variant="outline" onClick={() => { if (memberQuery.isError) void memberQuery.refetch(); if (isOwner && invitesQuery.isError) void invitesQuery.refetch(); }}>Retry</Button></div>;
  }

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
            <div className="space-y-2">
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
                      <p className={cn("text-muted-foreground/70 mt-1", isExpired && "text-destructive/70")}>
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
        <div className="space-y-2">
          {members.map((member) => {
            const isSelf = member.user_id === currentUserId;

            return (
              <div
                key={member.id}
                className="flex items-center gap-3 rounded-md border border-border/50 px-3 py-2"
              >
                <ProfileAvatar
                  label={displayName(member)}
                  seed={member.user_id}
                  src={member.image}
                  size={28}
                  data-testid={`members-avatar-${member.user_id}`}
                />

                {/* Name / email */}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate leading-tight">
                    {displayName(member)}
                    {isSelf && (
                      <span className="ml-2 text-xs text-muted-foreground font-normal">(you)</span>
                    )}
                  </p>
                  {member.name && (
                    <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                  )}
                </div>

                {/* Role badge */}
                <span
                  className={cn(
                    "text-xs px-2 py-1 rounded shrink-0",
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
