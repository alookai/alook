"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Agent } from "@alook/shared";
import type { AgentRuntime as Runtime } from "@alook/shared";
import { cn } from "@/lib/utils";
import { LockIcon } from "lucide-react";
import { CustomEmailForm } from "@/components/custom-email-form";
import {
  GeneralFields,
  PinToggle,
  AllowedSendersTab,
  AgentAccessTab,
} from "@/components/agent-form-fields";

interface AgentEditFormProps {
  agent: Agent;
  runtimes: Runtime[];
  modelOptions?: Record<string, string[]>;
  onSave: (data: {
    name: string;
    description: string;
    instructions: string;
    runtime_id: string;
    runtime_config?: Record<string, unknown>;
  }) => Promise<boolean>;
  onCancel: () => void;
  saving: boolean;
}

type TabId = "general" | "email" | "senders" | "access";

export function AgentEditForm({
  agent,
  runtimes,
  modelOptions,
  onSave,
  onCancel,
  saving,
}: AgentEditFormProps) {
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [name, setName] = useState(agent.name ?? "");
  const [description, setDescription] = useState(agent.description ?? "");
  const [instructions, setInstructions] = useState(agent.instructions ?? "");
  const [runtimeId, setRuntimeId] = useState(agent.runtime_id ?? "");
  const [model, setModel] = useState(() => {
    const rc = agent.runtime_config;
    return typeof rc?.model === "string" ? rc.model : "";
  });

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
      instructions,
      runtime_id: runtimeId,
      runtime_config: model ? { model } : {},
    });
  };

  const tabs: { id: TabId; label: string }[] = [
    { id: "general", label: "General" },
    { id: "email", label: "Email" },
    ...(agent.email_handle
      ? [{ id: "senders" as TabId, label: "Senders" }]
      : []),
    { id: "access", label: "Access" },
  ];

  const isFormTab = activeTab === "general" || activeTab === "email";

  return (
    <div className="flex flex-1 min-h-0">
      <nav className="w-48 shrink-0 border-r border-border/50 py-3 px-2 hidden md:block">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
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
        <div className="px-4 pt-2 md:hidden">
          <Tabs
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

        <div className="flex-1 overflow-y-auto thin-scrollbar px-5 py-6">
          {isFormTab ? (
            <form
              onSubmit={handleSubmit}
              className="mx-auto max-w-md space-y-4"
            >
              {activeTab === "general" && (
                <>
                  <GeneralFields
                    name={name}
                    setName={setName}
                    description={description}
                    setDescription={setDescription}
                    instructions={instructions}
                    setInstructions={setInstructions}
                    model={model}
                    setModel={setModel}
                    runtimeId={runtimeId}
                    setRuntimeId={setRuntimeId}
                    runtimes={runtimes}
                    providerModels={providerModels}
                  />
                  <PinToggle agentId={agent.id} />
                </>
              )}

              {activeTab === "email" && (
                <>
                  <div className="rounded-lg border border-border/50 bg-muted/30 px-4 py-3">
                    <div className="mb-2.5 flex items-center gap-1.5">
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
                          ? `${agent.email_handle}@alook.ai`
                          : "Not configured"}
                      </span>
                    </div>
                  </div>

                  <CustomEmailForm
                    agentId={agent.id}
                    workspaceId={agent.workspace_id}
                  />
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
          ) : activeTab === "senders" ? (
            <AllowedSendersTab agentId={agent.id} />
          ) : (
            <AgentAccessTab agentId={agent.id} ownerId={agent.owner_id} />
          )}
        </div>
      </div>
    </div>
  );
}
