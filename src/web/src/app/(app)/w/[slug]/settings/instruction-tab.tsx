"use client";

import { createStore, useSelector } from "@tanstack/react-store";
import { useQuery, useMutation, type Query } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useLayoutEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { isAbortError } from "@/lib/errors";
import { useWorkspaceOwner, captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions, runWorkspaceRequest } from "@/contexts/workspace-context";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { getMemberMe, updateMemberMe } from "@/lib/api";
import { MarkdownEditor } from "@/components/ui/markdown-editor";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const MAX_LENGTH = 50_000;
const DEBOUNCE_MS = 500;

function UsageRing({ ratio, size = 16, stroke = 1.5 }: { ratio: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const visual = ratio <= 0 ? 0 : ratio >= 1 ? 1 : Math.log1p(ratio * 99) / Math.log(100);
  const filled = visual * circ;
  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-border" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeDasharray={`${filled} ${circ - filled}`}
        strokeLinecap="round"
        className={cn(
          "transition-all duration-300",
          ratio > 0.9 ? "text-destructive/70" : ratio > 0.7 ? "text-yellow-500/50" : "text-muted-foreground/30"
        )}
      />
    </svg>
  );
}

export function InstructionTab() {
  const owner = useWorkspaceOwner();
  const { workspaceId } = owner;
  const source = useWorkspaceViewSource(owner, "workspace-instruction", true);
  const key = owner.key("member-instruction");
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => runWorkspaceRequest(owner, (options) => getMemberMe(workspaceId, options), signal) });
  type SaveIntent = { value: string; token: ReturnType<typeof captureWorkspaceOwner>; assertView: () => void; signal: AbortSignal; resource: Query | undefined };
  const draft = useMemo(() => {
    const draftKey = JSON.stringify(owner.key("instruction-draft"));
    const create = () => createStore<{ value: string | null; pending: SaveIntent | null }>({ value: null, pending: null });
    const saved = owner.application.preferences.get().localValues.get(draftKey) as ReturnType<typeof create> | undefined;
    if (saved) return saved;
    const store = create();
    owner.application.preferences.setState((state) => ({ ...state, localValues: new Map(state.localValues).set(draftKey, store) }));
    return store;
  }, [owner]);
  const edits = useSelector(draft, (state) => state);
  const value = edits.value ?? query.data?.global_instruction ?? "";
  const loading = query.isPending;
  const command = useMutation({ mutationKey: [...key, "command"], scope: { id: JSON.stringify(key) }, gcTime: 0,
    mutationFn: async ({ value, token, assertView, signal, resource: original }: SaveIntent) => {
      const assert = () => { assertWorkspaceOwner(token, signal); assertView(); };
      assert();
      if (original && owner.queryClient.getQueryCache().find({ queryKey: key, exact: true }) === original) await owner.queryClient.cancelQueries({ queryKey: key, exact: true });
      assert();
      const before = original?.state.data as { global_instruction: string } | undefined;
      const writes = original?.state.dataUpdateCount;
      try {
        const data = await updateMemberMe(workspaceId, value, { ...workspaceRequestOptions(token, signal, assert), keepalive: true });
        assert();
        if (original && owner.queryClient.getQueryCache().find({ queryKey: key, exact: true }) === original && original.state.dataUpdateCount === writes) {
          owner.queryClient.setQueryData<{ global_instruction: string }>(key, (current) => current?.global_instruction === before?.global_instruction ? data : current);
        }
        return data;
      } catch (error) { assert(); throw error; }
    },
    onSuccess: (_data, intent) => {
      try { intent.assertView(); } catch { return; }
      const confirmed = owner.queryClient.getQueryData<{ global_instruction: string }>(key)?.global_instruction;
      draft.setState((state) => state.value === intent.value && confirmed === intent.value ? { ...state, value: null } : state);
    },
    onError: (error, intent) => {
      try { intent.assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error(error instanceof Error ? error.message : "Failed to save");
    },
  });
  const mutateInstruction = command.mutate;
  const flush = useCallback(() => {
    const intent = draft.get().pending;
    if (!intent) return;
    try { intent.assertView(); assertWorkspaceOwner(intent.token, intent.signal); } catch { return; }
    draft.setState((state) => state.pending === intent ? { ...state, pending: null } : state);
    mutateInstruction(intent);
  }, [draft, mutateInstruction]);
  useEffect(() => {
    if (!edits.pending) return;
    const timer = setTimeout(flush, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [edits.pending, flush]);
  const handleChange = (value: string) => {
    source.assertActive();
    draft.setState((state) => ({ value, pending: {
      value, token: state.pending?.token ?? captureWorkspaceOwner(owner), assertView: state.pending?.assertView ?? source.assertActive, signal: state.pending?.signal ?? source.signal, resource: state.pending?.resource ?? owner.queryClient.getQueryCache().find({ queryKey: key, exact: true }),
    } }));
  };
  useEffect(() => {
    const onBeforeUnload = () => flush();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [flush]);
  useLayoutEffect(() => () => draft.setState((state) => ({ ...state, pending: null })), [draft]);
  useEffect(() => {
    if (query.data?.global_instruction !== edits.value || edits.pending || command.isPending) return;
    draft.setState((state) => state.value === query.data?.global_instruction ? { ...state, value: null } : state);
  }, [query.data, edits.value, edits.pending, command.isPending, draft]);

  const ratio = value.length / MAX_LENGTH;

  if (loading) {
    return (
      <div className="px-6 py-6 space-y-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (query.isError && !query.data) return <div role="alert" className="px-6 py-6 space-y-3">
    <p>Couldn’t load instructions.</p>
    <Button variant="outline" onClick={() => { source.assertActive(); void query.refetch({ cancelRefetch: false }); }}>Try again</Button>
  </div>;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 px-6 pt-4 pb-4">
        <MarkdownEditor
          value={value}
          onChange={handleChange}
          placeholder="Write instructions that every agent you own will follow..."
          minHeight="calc(100vh - 240px)"
          contentType="markdown"
          variant="seamless"
        />
      </div>
      <div className="flex items-center gap-2 px-6 py-3">
        {edits.value !== null && !edits.pending && !command.isPending && <Button size="sm" variant="outline" onClick={() => { handleChange(value); }}>Save changes</Button>}
        <UsageRing ratio={ratio} />
        <p className="text-xs text-muted-foreground">
          This instruction is prepended to every agent&apos;s individual instruction.
        </p>
      </div>
    </div>
  );
}
