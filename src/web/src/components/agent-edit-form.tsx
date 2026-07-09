"use client";

import { useState, useCallback, useEffect, useRef } from "react";
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
import { useWorkspace } from "@/contexts/workspace-context";
import { useAgentContext } from "@/contexts/agent-context";
import { getAgent as getAgentApi, updateAgent as updateAgentApi } from "@/lib/api";
import { toast } from "sonner";
import {
  GeneralFields,
  AllowedSendersTab,
  AgentAccessTab,
} from "@/components/agent-form-fields";
import {
  type AvatarConfig,
  AvatarPickerDialog,
  DEFAULT_CONFIG,
  parseAvatarUrl,
  serializeAvatarConfig,
} from "@/components/avatar";

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
  const { workspaceId } = useWorkspace();
  const { patchAgent } = useAgentContext();
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [name, setName] = useState(agent.name ?? "");
  const [description, setDescription] = useState(agent.description ?? "");
  const [runtimeId, setRuntimeId] = useState(agent.runtime_id ?? "");
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>(
    () => parseAvatarUrl(agent.avatar_url) ?? DEFAULT_CONFIG
  );
  const [model, setModel] = useState(() => {
    const rc = agent.runtime_config;
    return typeof rc?.model === "string" ? rc.model : "";
  });

  // Instruction tab state — auto-saves independently
  const [instructions, setInstructions] = useState(agent.instructions ?? "");
  const [savedInstructions, setSavedInstructions] = useState(agent.instructions ?? "");
  const instructionsRef = useRef(instructions);
  useEffect(() => {
    instructionsRef.current = instructions;
  }, [instructions]);
  const savedInstructionsRef = useRef(savedInstructions);
  useEffect(() => {
    savedInstructionsRef.current = savedInstructions;
  }, [savedInstructions]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingInstructionsRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getAgentApi(agent.id, workspaceId).then((fresh) => {
      if (cancelled) return;
      if (fresh.instructions !== instructionsRef.current && !savingInstructionsRef.current) {
        setInstructions(fresh.instructions);
        setSavedInstructions(fresh.instructions);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [agent.id, workspaceId]);

  const scheduleInstructionSaveRef = useRef<() => void>(() => {});

  const flushInstructions = useCallback(async () => {
    if (savingInstructionsRef.current) return;
    const current = instructionsRef.current;
    if (current === savedInstructionsRef.current) return;
    savingInstructionsRef.current = true;
    try {
      await updateAgentApi(agent.id, { instructions: current }, workspaceId);
      setSavedInstructions(current);
      patchAgent(agent.id, { instructions: current });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save instructions");
    } finally {
      savingInstructionsRef.current = false;
      if (instructionsRef.current !== savedInstructionsRef.current) {
        scheduleInstructionSaveRef.current();
      }
    }
  }, [agent.id, workspaceId, patchAgent]);

  const scheduleInstructionSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(flushInstructions, DEBOUNCE_MS);
  }, [flushInstructions]);

  useEffect(() => {
    scheduleInstructionSaveRef.current = scheduleInstructionSave;
  }, [scheduleInstructionSave]);

  const handleInstructionChange = useCallback(
    (next: string) => {
      setInstructions(next);
      scheduleInstructionSave();
    },
    [scheduleInstructionSave],
  );

  useEffect(() => {
    const onBeforeUnload = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (instructionsRef.current !== savedInstructionsRef.current) {
        const params = new URLSearchParams({ workspace_id: workspaceId });
        fetch(`/api/agents/${agent.id}?${params}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instructions: instructionsRef.current }),
          keepalive: true,
        });
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [agent.id, workspaceId]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (instructionsRef.current !== savedInstructionsRef.current) {
        const params = new URLSearchParams({ workspace_id: workspaceId });
        fetch(`/api/agents/${agent.id}?${params}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instructions: instructionsRef.current }),
          keepalive: true,
        });
      }
    };
  }, [agent.id, workspaceId]);

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
      avatar_url: serializeAvatarConfig(avatarConfig),
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
            <div className="flex-1 px-6 pt-4 pb-4 overflow-y-auto">
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
                      config={avatarConfig}
                      onChange={setAvatarConfig}
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
