"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/contexts/workspace-context";
import { useSession } from "@/lib/auth-client";
import {
  getMemberMe,
  updateMemberMe,
  listMembers,
  updateWorkspace,
  deleteWorkspace,
  listWorkspaces,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarkdownEditor } from "@/components/ui/markdown-editor";
import { Skeleton } from "@/components/ui/skeleton";

const MAX_LENGTH = 50_000;

export function GeneralTab() {
  const { workspaceId, slug } = useWorkspace();
  const session = useSession();
  const router = useRouter();

  // Global instruction state
  const [value, setValue] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [loadingInstruction, setLoadingInstruction] = useState(true);
  const [saving, setSaving] = useState(false);

  // Role state — must be declared before isOwner
  const [memberRole, setMemberRole] = useState<string>("");
  const [loadingRole, setLoadingRole] = useState(true);

  // Workspace name/slug editing
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [savedWorkspaceName, setSavedWorkspaceName] = useState("");
  const [savedWorkspaceSlug, setSavedWorkspaceSlug] = useState("");
  const [savingWorkspace, setSavingWorkspace] = useState(false);

  // Danger zone
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  // isOwner derived from memberRole state
  const isOwner = memberRole === "owner";

  // Fetch global instruction
  const fetchInstruction = useCallback(async () => {
    setLoadingInstruction(true);
    try {
      const data = await getMemberMe(workspaceId);
      setValue(data.global_instruction);
      setSavedValue(data.global_instruction);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setLoadingInstruction(false);
    }
  }, [workspaceId]);

  // Fetch members to determine role + workspace info
  const fetchMembersAndWorkspace = useCallback(async () => {
    setLoadingRole(true);
    try {
      const currentEmail = session.data?.user?.email;
      const [members, workspaces] = await Promise.all([
        listMembers(workspaceId),
        listWorkspaces(),
      ]);

      const me = members.find((m) => m.email === currentEmail);
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
      setLoadingRole(false);
    }
  }, [workspaceId, session.data?.user?.email]);

  useEffect(() => {
    fetchInstruction();
  }, [fetchInstruction]);

  useEffect(() => {
    if (session.data) {
      fetchMembersAndWorkspace();
    }
  }, [fetchMembersAndWorkspace, session.data]);

  // Dirty tracking refs for save/unload
  const isDirty = value !== savedValue;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await updateMemberMe(workspaceId, value);
      setSavedValue(data.global_instruction);
      toast.success("Settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  // Warn on unsaved changes when navigating away
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Cmd+S / Ctrl+S to save
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirtyRef.current) handleSaveRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Save workspace name/slug
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

  // Delete workspace
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

  const loading = loadingInstruction || loadingRole;

  if (loading) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-10">
      {/* Owner-only: workspace name/slug */}
      {isOwner && (
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
      )}

      {/* All members: Global Instruction */}
      <section className="space-y-4">
        <div>
          <Label htmlFor="global-instruction">Global Instruction</Label>
        </div>
        <MarkdownEditor
          value={value}
          onChange={setValue}
          placeholder="Write instructions that every agent you own will follow..."
          minHeight="240px"
          contentType="markdown"
        />
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground/70">
            This markdown instruction is prepended to every agent&apos;s individual instruction.
          </p>
          <span className="text-xs text-muted-foreground tabular-nums shrink-0 ml-4">
            {value.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-2 pt-2">
          <Button size="sm" onClick={handleSave} disabled={!isDirty || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </section>

      {/* Owner-only: Danger zone */}
      {isOwner && (
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
      )}
    </div>
  );
}
