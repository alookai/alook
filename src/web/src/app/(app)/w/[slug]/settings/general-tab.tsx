"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/contexts/workspace-context";
import { useSession } from "@/lib/auth-client";
import {
  listMembers,
  updateWorkspace,
  deleteWorkspace,
  listWorkspaces,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export function GeneralTab() {
  const { workspaceId, slug } = useWorkspace();
  const session = useSession();
  const router = useRouter();

  const [memberRole, setMemberRole] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [savedWorkspaceName, setSavedWorkspaceName] = useState("");
  const [savedWorkspaceSlug, setSavedWorkspaceSlug] = useState("");
  const [savingWorkspace, setSavingWorkspace] = useState(false);

  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  const isOwner = memberRole === "owner";

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const currentUserId = session.data?.user?.id;
      const [members, workspaces] = await Promise.all([
        listMembers(workspaceId),
        listWorkspaces(),
      ]);

      const me = members.find((m) => m.user_id === currentUserId);
      setMemberRole(me?.role ?? "");

      const ws = workspaces.find((w) => w.id === workspaceId);
      if (ws) {
        setWorkspaceName(ws.name);
        setWorkspaceSlug(ws.slug);
        setSavedWorkspaceName(ws.name);
        setSavedWorkspaceSlug(ws.slug);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load workspace info");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, session.data?.user?.id]);

  useEffect(() => {
    if (session.data) fetchData();
  }, [fetchData, session.data]);

  const isWorkspaceDirty =
    workspaceName !== savedWorkspaceName || workspaceSlug !== savedWorkspaceSlug;

  const handleSaveWorkspace = async () => {
    setSavingWorkspace(true);
    try {
      const updated = await updateWorkspace(workspaceId, {
        name: workspaceName,
        slug: workspaceSlug,
      });
      setSavedWorkspaceName(updated.name);
      setSavedWorkspaceSlug(updated.slug);
      toast.success("Workspace updated");
      if (updated.slug !== slug) {
        router.replace(`/w/${updated.slug}/settings`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update workspace");
    } finally {
      setSavingWorkspace(false);
    }
  };

  const handleDelete = async () => {
    if (deleteConfirm !== savedWorkspaceName) return;
    setDeleting(true);
    try {
      await deleteWorkspace(workspaceId, savedWorkspaceName);
      toast.success("Workspace deleted");
      router.replace("/workspaces");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete workspace");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!isOwner) {
    return (
      <p className="text-sm text-muted-foreground">
        Only workspace owners can edit workspace settings.
      </p>
    );
  }

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h2 className="text-sm font-medium">Workspace</h2>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              placeholder="Workspace name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workspace-slug">Slug</Label>
            <Input
              id="workspace-slug"
              value={workspaceSlug}
              onChange={(e) => setWorkspaceSlug(e.target.value)}
              placeholder="workspace-slug"
            />
            <p className="text-xs text-muted-foreground/70">
              Used in URLs: /w/{workspaceSlug}/
            </p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={handleSaveWorkspace}
          disabled={!isWorkspaceDirty || savingWorkspace}
        >
          {savingWorkspace ? "Saving…" : "Save"}
        </Button>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-medium text-destructive">Danger Zone</h2>
        <div className="rounded-md border border-destructive/30 p-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Deleting this workspace is permanent and cannot be undone. All agents,
            conversations, and data will be lost.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="delete-confirm" className="text-xs">
              Type <span className="font-medium text-foreground">{savedWorkspaceName}</span> to confirm
            </Label>
            <Input
              id="delete-confirm"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={savedWorkspaceName}
            />
          </div>
          <Button
            size="sm"
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteConfirm !== savedWorkspaceName || deleting}
          >
            {deleting ? "Deleting…" : "Delete Workspace"}
          </Button>
        </div>
      </section>
    </div>
  );
}
