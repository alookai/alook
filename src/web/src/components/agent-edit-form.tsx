"use client";

import { useCallback, useEffect, useRef, useMemo, useLayoutEffect } from "react";
import { useAtom, useCreateAtom, createStore, useSelector } from "@tanstack/react-store";
import { useMutation, useQuery, type Query } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Agent } from "@alook/shared";
import type { AgentRuntime as Runtime } from "@alook/shared";
import { toAlookAddress } from "@alook/shared";
import { cn } from "@/lib/utils";
import { LockIcon } from "lucide-react";
import { CustomEmailForm } from "@/components/custom-email-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarkdownEditor } from "@/components/ui/markdown-editor";
import { RuntimeSelect } from "@/components/runtime-select";
import { useWorkspaceOwner, captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions } from "@/contexts/workspace-context";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { isAbortError } from "@/lib/errors";
import { useAgentContext } from "@/contexts/agent-context";
import { getAgent as getAgentApi, updateAgent as updateAgentApi } from "@/lib/api";
import { toast } from "sonner";
import {
  GeneralFields,
  AllowedSendersTab,
  AgentAccessTab,
} from "@/components/agent-form-fields";
import { AvatarPickerDialog } from "@/components/avatar";
import { serializeBeamSeed, parseBeamSeed } from "@/lib/avatar/seed-url";

const MAX_INSTRUCTION_LENGTH = 50_000;
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

function RuntimeTab({
  model,
  setModel,
  runtimeId,
  setRuntimeId,
  runtimes,
  providerModels,
}: {
  model: string;
  setModel: (v: string) => void;
  runtimeId: string;
  setRuntimeId: (v: string) => void;
  runtimes: Runtime[];
  providerModels: string[];
}) {
  return (
    <>
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Runtime</Label>
        <RuntimeSelect
          value={runtimeId}
          onValueChange={(newId) => {
            const oldProvider = runtimes.find((r) => r.id === runtimeId)?.provider;
            const newProvider = runtimes.find((r) => r.id === newId)?.provider;
            setRuntimeId(newId);
            if (oldProvider && oldProvider !== newProvider) {
              setModel("");
            }
          }}
          runtimes={runtimes}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Model</Label>
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Default (runtime model)"
          list="agent-model-options-edit"
        />
        {providerModels.length > 0 && (
          <datalist id="agent-model-options-edit">
            {providerModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        )}
        <p className="text-xs text-muted-foreground/70">
          Optional. Leave blank to use the runtime&apos;s default model.
        </p>
      </div>
    </>
  );
}

interface AgentEditFormProps {
  agent: Agent;
  runtimes: Runtime[];
  modelOptions?: Record<string, string[]>;
  onSave: (data: {
    name: string;
    description: string;
    runtime_id: string;
    runtime_config?: Record<string, unknown>;
    avatar_url?: string | null;
  }) => Promise<boolean>;
  onCancel: () => void;
  saving: boolean;
}

type TabId = "general" | "instruction" | "runtime" | "email" | "permission";

export function AgentEditForm({
  agent,
  runtimes,
  modelOptions,
  onSave,
  onCancel,
  saving,
}: AgentEditFormProps) {
  const owner = useWorkspaceOwner();
  const { workspaceId } = owner;
  const { agents } = useAgentContext();
  const canonicalAgent = agents.find((row) => row.id === agent.id);
  const source = useWorkspaceViewSource(owner, `agent-edit:${agent.id}`, true);
  const [activeTab, setActiveTab] = useAtom(useCreateAtom<TabId>("general"));
  const [name, setName] = useAtom(useCreateAtom(agent.name ?? ""));
  const [description, setDescription] = useAtom(useCreateAtom(agent.description ?? ""));
  const [runtimeId, setRuntimeId] = useAtom(useCreateAtom(agent.runtime_id ?? ""));
  const [avatarUrl, setAvatarUrl] = useAtom(useCreateAtom<string>(
    parseBeamSeed(agent.avatar_url) ? agent.avatar_url! : serializeBeamSeed(agent.id),
  ));
  const [model, setModel] = useAtom(useCreateAtom(typeof agent.runtime_config?.model === "string" ? agent.runtime_config.model : ""));

  type InstructionIntent = { value: string; token: ReturnType<typeof captureWorkspaceOwner>; assertView: () => void; signal: AbortSignal; resource: Query | undefined };
  const draft = useMemo(() => {
    const key = JSON.stringify(owner.key("agent-instruction-draft", agent.id));
    const create = () => createStore<{ value: string | null; pending: InstructionIntent | null }>({ value: null, pending: null });
    const saved = owner.application.preferences.get().localValues.get(key) as ReturnType<typeof create> | undefined;
    if (saved) return saved;
    const store = create();
    owner.application.preferences.setState((state) => ({ ...state, localValues: new Map(state.localValues).set(key, store) }));
    return store;
  }, [owner, agent.id]);
  const instructionDraft = useSelector(draft, (state) => state.value);
  const pendingInstruction = useSelector(draft, (state) => state.pending);
  const instructions = instructionDraft ?? canonicalAgent?.instructions ?? "";
  const agentsKey = owner.key("agents");
  useQuery({ queryKey: owner.key("agent-refresh", agent.id),
    queryFn: async ({ signal }) => {
      const token = captureWorkspaceOwner(owner);
      assertWorkspaceOwner(token, signal);
      const original = owner.queryClient.getQueryCache().find({ queryKey: agentsKey, exact: true });
      const baseline = owner.queryClient.getQueryData<Agent[]>(agentsKey)?.find((row) => row.id === agent.id);
      const writes = original?.state.dataUpdateCount;
      const fresh = await getAgentApi(agent.id, workspaceId, workspaceRequestOptions(token, signal));
      assertWorkspaceOwner(token, signal);
      if (owner.queryClient.getQueryCache().find({ queryKey: agentsKey, exact: true }) === original && original?.state.dataUpdateCount === writes) {
        owner.queryClient.setQueryData<Agent[]>(agentsKey, (rows) => rows?.map((row) => {
          if (row.id !== fresh.id) return row;
          const fields = Object.fromEntries(Object.entries(fresh).filter(([key]) => row[key as keyof Agent] === baseline?.[key as keyof Agent]));
          return { ...row, ...fields };
        }));
      }
      return { id: fresh.id };
    },
  });
  const instructionMutation = useMutation({
    mutationKey: owner.key("agent-instruction-command", agent.id),
    scope: { id: JSON.stringify(owner.key("agent-instruction-command", agent.id)) }, gcTime: 0,
    mutationFn: async ({ value, token, assertView, signal, resource: original }: InstructionIntent) => {
      const assert = () => { assertWorkspaceOwner(token, signal); assertView(); };
      assert();
      if (original && owner.queryClient.getQueryCache().find({ queryKey: agentsKey, exact: true }) === original) await owner.queryClient.cancelQueries({ queryKey: agentsKey, exact: true });
      assert();
      const before = owner.queryClient.getQueryData<Agent[]>(agentsKey)?.find((row) => row.id === agent.id)?.instructions;
      const writes = original?.state.dataUpdateCount;
      try {
        const confirmed = await updateAgentApi(agent.id, { instructions: value }, workspaceId, { ...workspaceRequestOptions(token, signal, assert), keepalive: true });
        assert();
        if (original && owner.queryClient.getQueryCache().find({ queryKey: agentsKey, exact: true }) === original && original.state.dataUpdateCount === writes) {
          owner.queryClient.setQueryData<Agent[]>(agentsKey, (rows) => rows?.map((row) => row.id === agent.id && row.instructions === before ? { ...row, instructions: confirmed.instructions } : row));
        }
      } catch (error) { assert(); throw error; }
    },
    onSuccess: (_data, intent) => {
      try { intent.assertView(); } catch { return; }
      const confirmed = owner.queryClient.getQueryData<Agent[]>(agentsKey)?.find((row) => row.id === agent.id)?.instructions;
      draft.setState((state) => state.value === intent.value && confirmed === intent.value ? { ...state, value: null } : state);
    },
    onError: (error, intent) => {
      try { intent.assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error(error instanceof Error ? error.message : "Failed to save instructions");
    },
  });
  const flush = useCallback(() => {
    const intent = draft.get().pending;
    if (!intent) return;
    try { intent.assertView(); assertWorkspaceOwner(intent.token, intent.signal); } catch { return; }
    draft.setState((state) => state.pending === intent ? { ...state, pending: null } : state);
    instructionMutation.mutate(intent);
  }, [draft, instructionMutation]);
  const flushRef = useRef(flush);
  useEffect(() => { flushRef.current = flush; }, [flush]);
  useEffect(() => {
    if (!pendingInstruction) return;
    const timer = setTimeout(() => flushRef.current(), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [pendingInstruction]);
  const handleInstructionChange = (value: string) => {
    source.assertActive();
    draft.setState((state) => ({ value, pending: {
      value, token: state.pending?.token ?? captureWorkspaceOwner(owner), assertView: state.pending?.assertView ?? source.assertActive, signal: state.pending?.signal ?? source.signal, resource: state.pending?.resource ?? owner.queryClient.getQueryCache().find({ queryKey: agentsKey, exact: true }),
    } }));
  };
  useEffect(() => {
    const onBeforeUnload = () => flushRef.current();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [owner, agent.id]);
  useLayoutEffect(() => () => draft.setState((state) => ({ ...state, pending: null })), [draft]);


  const selectedRuntime = runtimes.find((r) => r.id === runtimeId);
  const providerModels =
    selectedRuntime && modelOptions
      ? (modelOptions[selectedRuntime.provider] ?? [])
      : [];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave({
      name,
      description,
      runtime_id: runtimeId,
      runtime_config: model ? { model } : {},
      avatar_url: avatarUrl,
    });
  };

  const tabs: { id: TabId; label: string }[] = [
    { id: "general", label: "General" },
    { id: "instruction", label: "Instruction" },
    { id: "runtime", label: "Runtime" },
    { id: "email", label: "Email" },
    { id: "permission", label: "Permission" },
  ];

  const isFormTab = activeTab === "general" || activeTab === "runtime" || activeTab === "email";
  const instructionRatio = instructions.length / MAX_INSTRUCTION_LENGTH;

  return (
    <div className="flex flex-1 min-h-0">
      <nav className="w-48 shrink-0 border-r border-border/50 py-3 px-2 hidden sm:block">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "w-full rounded-md px-2 py-2 text-left text-sm transition-colors",
              activeTab === tab.id
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="px-4 pt-2 sm:hidden">
          <Tabs
            className="items-center"
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as TabId)}
          >
            <TabsList className="h-auto gap-1">
              {tabs.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {activeTab === "instruction" ? (
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 px-6 pt-4 pb-4 overflow-y-auto thin-scrollbar">
              <MarkdownEditor
                value={instructions}
                onChange={handleInstructionChange}
                placeholder="Write instructions for this agent..."
                minHeight="calc(100vh - 240px)"
                contentType="markdown"
                variant="seamless"
              />
            </div>
            <div className="flex items-center gap-2 px-6 py-3 border-t border-border/50">
              <UsageRing ratio={instructionRatio} />
              <p className="text-xs text-muted-foreground">
                Agent-specific instruction. Your global instruction is prepended automatically.
              </p>
              {instructionDraft !== null && (
                <Button type="button" size="sm" variant="outline" className="ml-auto shrink-0" disabled={instructionMutation.isPending} onClick={() => { handleInstructionChange(instructions); flushRef.current(); }}>
                  {instructionMutation.isPending ? "Saving…" : "Save changes"}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto thin-scrollbar px-4 py-6">
            {isFormTab ? (
              <form
                onSubmit={handleSubmit}
                className="mx-auto max-w-md space-y-4"
              >
                {activeTab === "general" && (
                  <>
                    <AvatarPickerDialog
                      value={avatarUrl}
                      onChange={setAvatarUrl}
                    />
                    <GeneralFields
                      name={name}
                      setName={setName}
                      description={description}
                      setDescription={setDescription}
                      model={model}
                      setModel={setModel}
                      runtimeId={runtimeId}
                      setRuntimeId={setRuntimeId}
                      runtimes={[]}
                      providerModels={[]}
                    />
                  </>
                )}

                {activeTab === "runtime" && (
                  <RuntimeTab
                    model={model}
                    setModel={setModel}
                    runtimeId={runtimeId}
                    setRuntimeId={setRuntimeId}
                    runtimes={runtimes}
                    providerModels={providerModels}
                  />
                )}

                {activeTab === "email" && (
                  <>
                    <div className="rounded-lg border border-border/50 bg-muted/30 px-4 py-3">
                      <div className="mb-2 flex items-center gap-2">
                        <LockIcon className="size-3 text-muted-foreground/60" />
                        <span className="text-xs font-medium text-muted-foreground/60">
                          Set at creation
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">
                          Email
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {agent.email_handle
                            ? toAlookAddress(agent.email_handle)
                            : "Not configured"}
                        </span>
                      </div>
                    </div>

                    <CustomEmailForm
                      agentId={agent.id}
                      workspaceId={agent.workspace_id}
                    />

                    {agent.email_handle && (
                      <div className="border-t border-border/50 pt-4 mt-4">
                        <AllowedSendersTab agentId={agent.id} />
                      </div>
                    )}
                  </>
                )}

                <div className="flex items-center gap-2 pt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onCancel}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={saving || !name}>
                    {saving ? "Saving..." : "Save"}
                  </Button>
                </div>
              </form>
            ) : (
              <AgentAccessTab agentId={agent.id} ownerId={agent.owner_id} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
