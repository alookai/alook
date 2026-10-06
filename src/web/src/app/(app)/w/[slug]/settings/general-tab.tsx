"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { sanitizeSlug } from "@alook/shared";
import { useWorkspaceOwner, captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions } from "@/contexts/workspace-context";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { useObservedRegion } from "@/lib/observability/regions";
import { mergeEvidence, valueEvidence } from "@/lib/observability/data-source";
import { useQuery, useMutation, type Query } from "@tanstack/react-query";
import { applicationWorkspacesOptions, workspaceMembersOptions } from "@/hooks/workspace/settings-query-options";

import { updateWorkspace, deleteWorkspace, listWorkspaces } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type WorkspaceFormErrors,
  hasWorkspaceFormErrors,
  validateWorkspaceForm,
} from "@/lib/form-validation";
import { trackSettingsUpdated } from "@/lib/analytics";

export function GeneralTab() {
  const owner = useWorkspaceOwner();
  const { workspaceId, slug } = owner;
  const source = useWorkspaceViewSource(owner, "workspace-general", true);
  const router = useRouter();
  const membersQuery = useQuery(workspaceMembersOptions(owner));
  const workspacesQuery = useQuery(applicationWorkspacesOptions(owner.application));
  const current = workspacesQuery.data?.find((workspace) => workspace.id === workspaceId);
  const memberRole = membersQuery.data?.find((member) => member.user_id === owner.application.userId)?.role ?? "";
  const loading = membersQuery.isPending || workspacesQuery.isPending;
  useObservedRegion("settings", !loading && !membersQuery.isError && !workspacesQuery.isError, mergeEvidence([valueEvidence(owner.queryClient, membersQuery.data), valueEvidence(owner.queryClient, workspacesQuery.data)]));
  const [nameDraft, setWorkspaceName] = useAtom(useCreateAtom<string | null>(null));
  const [slugDraft, setWorkspaceSlug] = useAtom(useCreateAtom<string | null>(null));
  const workspaceName = nameDraft ?? current?.name ?? "";
  const workspaceSlug = slugDraft ?? current?.slug ?? "";
  const savedWorkspaceName = current?.name ?? "";
  const savedWorkspaceSlug = current?.slug ?? "";
  const [workspaceErrors, setWorkspaceErrors] = useAtom(useCreateAtom<WorkspaceFormErrors>({}));
  const [deleteConfirm, setDeleteConfirm] = useAtom(useCreateAtom(""));
  type OriginalIntent = { token: ReturnType<typeof captureWorkspaceOwner>; view: ReturnType<typeof source.capture>; resources: Query[] };
  const native = useMutation({ meta: { observabilityAction: "workspace.settings.command" }, mutationKey: owner.key("workspace-settings-command"), scope: { id: JSON.stringify(owner.key("workspace-settings-command")) }, gcTime: 0,
    mutationFn: async ({ action, token, view, resources }: { action: { kind: "update"; name: string; slug: string } | { kind: "delete"; name: string }; token: ReturnType<typeof captureWorkspaceOwner> } & OriginalIntent) => {
      const assert = () => { assertWorkspaceOwner(token, view.signal); view.assert(); };
      const key = applicationWorkspacesOptions(owner.application).queryKey;
      assert();
      const original = resources.find((query) => JSON.stringify(query.queryKey) === JSON.stringify(key));
      if (original && owner.queryClient.getQueryCache().find({ queryKey: key, exact: true }) === original) await owner.queryClient.cancelQueries({ queryKey: key, exact: true });
      assert();
      const before = owner.queryClient.getQueryData<Awaited<ReturnType<typeof listWorkspaces>>>(key)?.find((row) => row.id === workspaceId);
      const writes = original?.state.dataUpdateCount;
      const options = workspaceRequestOptions(token, view.signal, assert);
      try {
        const updated = action.kind === "update" ? await updateWorkspace(workspaceId, { name: action.name, slug: action.slug }, options)
          : (await deleteWorkspace(workspaceId, action.name, options), null);
        assert();
        if (original && owner.queryClient.getQueryCache().find({ queryKey: key, exact: true }) === original && original.state.dataUpdateCount === writes) {
          owner.queryClient.setQueryData<Awaited<ReturnType<typeof listWorkspaces>>>(key, (rows) => action.kind === "delete" ? rows?.filter((row) => row.id !== workspaceId)
            : rows?.map((row) => row.id !== workspaceId ? row : { ...row, name: row.name === before?.name ? updated!.name : row.name, slug: row.slug === before?.slug ? updated!.slug : row.slug }));
        }
        if (action.kind === "delete") for (const query of resources.filter((query) => owner.key().every((part, index) => Object.is(part, query.queryKey[index])))) {
          if (owner.queryClient.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query) owner.queryClient.removeQueries({ queryKey: query.queryKey, exact: true });
        }
        if (original && owner.queryClient.getQueryCache().find({ queryKey: key, exact: true }) === original) await owner.queryClient.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
        assert();
        return updated && original && owner.queryClient.getQueryCache().find({ queryKey: key, exact: true }) === original ? owner.queryClient.getQueryData<Awaited<ReturnType<typeof listWorkspaces>>>(key)?.find((row) => row.id === workspaceId) ?? null : null;
      } catch (error) { assert(); throw error; }
    },
  });
  const capture = (input: Omit<Parameters<typeof native.mutate>[0], "view" | "resources">) => { const view = source.capture(); view.assert(); assertWorkspaceOwner(input.token, view.signal); return { ...input, view, resources: [...new Set([...owner.queryClient.getQueryCache().findAll({ queryKey: owner.key() }), ...owner.queryClient.getQueryCache().findAll({ queryKey: applicationWorkspacesOptions(owner.application).queryKey, exact: true })])] }; };
  const command = { ...native, mutate: (input: Omit<Parameters<typeof native.mutate>[0], "view" | "resources">) => native.mutate(capture(input)), mutateAsync: (input: Omit<Parameters<typeof native.mutate>[0], "view" | "resources">) => native.mutateAsync(capture(input)) };
  const savingWorkspace = command.isPending && command.variables?.action.kind === "update";
  const deleting = command.isPending && command.variables?.action.kind === "delete";
  const isOwner = memberRole === "owner";
  const isWorkspaceDirty = workspaceName !== savedWorkspaceName || workspaceSlug !== savedWorkspaceSlug;

  const handleSaveWorkspace = async () => {
    if (owner.queryClient.isMutating({ mutationKey: owner.key("workspace-settings-command"), exact: true })) return;
    const cleanSlug = sanitizeSlug(workspaceSlug);
    setWorkspaceSlug(cleanSlug);
    const values = { name: workspaceName.trim(), slug: cleanSlug };
    const nextErrors = validateWorkspaceForm(values);
    setWorkspaceErrors(nextErrors);
    if (hasWorkspaceFormErrors(nextErrors)) return;
    const assert = source.capture().assert;
    assert();
    try {
      const updated = await command.mutateAsync({ action: { kind: "update", ...values }, token: captureWorkspaceOwner(owner) });
      assert();
      trackSettingsUpdated({ setting_tab: "general" });
      setWorkspaceName((value) => value?.trim() === values.name ? null : value);
      setWorkspaceSlug((value) => value === cleanSlug ? null : value);
      toast.success("Workspace updated");
      if (updated && updated.slug !== slug) router.replace(`/w/${updated.slug}/settings`);
    } catch (error) {
      try { assert(); } catch { return; }
      if (!(error instanceof DOMException && error.name === "AbortError")) toast.error(error instanceof Error ? error.message : "Failed to update workspace");
    }
  };

  const handleDelete = async () => {
    if (owner.queryClient.isMutating({ mutationKey: owner.key("workspace-settings-command"), exact: true })) return;
    if (deleteConfirm !== savedWorkspaceName) return;
    const assert = source.capture().assert;
    assert();
    try {
      await command.mutateAsync({ action: { kind: "delete", name: savedWorkspaceName }, token: captureWorkspaceOwner(owner) });
      assert();
      toast.success("Workspace deleted");
      router.replace("/workspaces");
    } catch (error) {
      try { assert(); } catch { return; }
      if (!(error instanceof DOMException && error.name === "AbortError")) toast.error(error instanceof Error ? error.message : "Failed to delete workspace");
    }
  };

  if (membersQuery.isError || workspacesQuery.isError) {
    return <div role="alert" className="space-y-3"><p className="text-sm text-destructive">Could not load workspace settings.</p><Button size="sm" variant="outline" onClick={() => { if (membersQuery.isError) void membersQuery.refetch(); if (workspacesQuery.isError) void workspacesQuery.refetch(); }}>Retry</Button></div>;
  }

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
          <div className="space-y-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              value={workspaceName}
              onChange={(e) => {
                const nextName = e.target.value;
                setWorkspaceName(nextName);
                if (workspaceErrors.name && nextName.trim()) {
                  setWorkspaceErrors((prev) => ({ ...prev, name: undefined }));
                }
              }}
              placeholder="Workspace name"
              aria-invalid={Boolean(workspaceErrors.name)}
              aria-describedby={workspaceErrors.name ? "workspace-name-error" : undefined}
            />
            {workspaceErrors.name && (
              <p id="workspace-name-error" className="text-xs text-destructive">
                {workspaceErrors.name}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="workspace-slug">Slug</Label>
            <Input
              id="workspace-slug"
              value={workspaceSlug}
              onChange={(e) => {
                const nextSlug = e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
                setWorkspaceSlug(nextSlug);
                if (workspaceErrors.slug && nextSlug.trim()) {
                  setWorkspaceErrors((prev) => ({ ...prev, slug: undefined }));
                }
              }}
              onBlur={() => setWorkspaceSlug(sanitizeSlug(workspaceSlug))}
              placeholder="workspace-slug"
              aria-invalid={Boolean(workspaceErrors.slug)}
              aria-describedby={workspaceErrors.slug ? "workspace-slug-error" : undefined}
            />
            {workspaceErrors.slug && (
              <p id="workspace-slug-error" className="text-xs text-destructive">
                {workspaceErrors.slug}
              </p>
            )}
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
          <div className="space-y-2">
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
