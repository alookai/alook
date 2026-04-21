"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetTitle,
  SheetBody,
} from "@/components/ui/sheet";
import { RuntimeSelect } from "@/components/runtime-select";
import type { Agent } from "@alook/shared";
import { isValidHandle } from "@alook/shared";
import type { AgentRuntime as Runtime } from "@alook/shared";
import { cn } from "@/lib/utils";
import { LockIcon, XIcon, ChevronRightIcon } from "lucide-react";
import { useWorkspace } from "@/contexts/workspace-context";
import { CustomEmailForm, type CustomEmailData } from "@/components/custom-email-form";
import {
  listWhitelist,
  addWhitelistEmail,
  removeWhitelistEmail,
  type WhitelistEntry,
} from "@/lib/api";

function nameToHandle(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

interface AgentEditFormProps {
  agent?: Agent;
  runtimes: Runtime[];
  defaultRuntimeId?: string;
  modelOptions?: Record<string, string[]>;
  onSave: (data: {
    name: string;
    description: string;
    instructions: string;
    runtime_id: string;
    email_handle?: string;
    runtime_config?: Record<string, unknown>;
    custom_email?: CustomEmailData;
  }) => Promise<boolean>;
  onCancel: () => void;
  saving: boolean;
  submitLabel?: string;
  savingLabel?: string;
}

export function AgentEditForm({
  agent,
  runtimes,
  defaultRuntimeId = "",
  modelOptions,
  onSave,
  onCancel,
  saving,
  submitLabel = "Save",
  savingLabel = "Saving...",
}: AgentEditFormProps) {
  const { workspaceId } = useWorkspace();
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [runtimeId, setRuntimeId] = useState(
    agent?.runtime_id ?? defaultRuntimeId
  );
  const [emailHandle, setEmailHandle] = useState(agent?.email_handle ?? "");
  const [customEmailData, setCustomEmailData] = useState<CustomEmailData | null>(null);
  const customEmailGetDataRef = useRef<(() => CustomEmailData | null) | null>(null);
  const [model, setModel] = useState(
    () => {
      const rc = agent?.runtime_config;
      return typeof rc?.model === "string" ? rc.model : "";
    }
  );

  const selectedRuntime = runtimes.find((r) => r.id === runtimeId);
  const providerModels = selectedRuntime && modelOptions
    ? modelOptions[selectedRuntime.provider] ?? []
    : [];

  const derivedHandle = nameToHandle(name);
  const effectiveHandle = emailHandle || derivedHandle;
  const handleError =
    effectiveHandle && !isValidHandle(effectiveHandle)
      ? "Must be 3+ characters, letters/numbers/hyphens only"
      : "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave({
      name,
      description,
      instructions,
      runtime_id: runtimeId,
      email_handle: emailHandle || derivedHandle || undefined,
      runtime_config: model ? { model } : {},
      custom_email: customEmailGetDataRef.current?.() ?? customEmailData ?? undefined,
    });
  };

  return (
    <div className="flex-1 overflow-y-auto px-5 py-6">
      <form onSubmit={handleSubmit} className="mx-auto max-w-md space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="agent-name">Name</Label>
          <Input
            id="agent-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Agent"
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="agent-description">Description</Label>
          <Input
            id="agent-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this agent do?"
          />
        </div>

        {!agent && (
          <div className="space-y-1.5">
            <Label htmlFor="agent-handle">Email Handle</Label>
            <div className="flex items-center gap-0">
              <Input
                id="agent-handle"
                value={emailHandle}
                onChange={(e) => setEmailHandle(e.target.value.toLowerCase())}
                placeholder={derivedHandle || "my-agent"}
                className="rounded-r-none"
              />
              <span className="inline-flex h-8 items-center rounded-r-lg border border-l-0 border-input bg-muted px-2.5 text-sm text-muted-foreground">
                @alook.ai
              </span>
            </div>
            {effectiveHandle && (
              <p className={cn(
                "text-xs",
                handleError ? "text-destructive" : "text-muted-foreground"
              )}>
                {handleError || `${effectiveHandle}@alook.ai`}
              </p>
            )}
            <p className="text-xs text-muted-foreground/70">
              This cannot be changed after creation.
            </p>
          </div>
        )}

        {!agent && (
          <CustomEmailForm
            workspaceId={workspaceId}
            onDataChange={setCustomEmailData}
            getDataRef={customEmailGetDataRef}
          />
        )}

        <div className="space-y-1.5">
          <Label htmlFor="agent-instructions">Instructions</Label>
          <Textarea
            id="agent-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="System prompt or instructions..."
            rows={6}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="agent-model">Model</Label>
          <Input
            id="agent-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Default (runtime model)"
            list="agent-model-options"
          />
          {providerModels.length > 0 && (
            <datalist id="agent-model-options">
              {providerModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          )}
          <p className="text-xs text-muted-foreground/70">
            Optional. Leave blank to use the runtime&apos;s default model.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="agent-runtime">Runtime</Label>
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

        {agent && agent.email_handle && (
          <WhitelistTrigger agentId={agent.id} />
        )}

        {agent && (
          <div className="rounded-lg border border-border/50 bg-muted/30 px-4 py-3">
            <div className="mb-2.5 flex items-center gap-1.5">
              <LockIcon className="size-3 text-muted-foreground/60" />
              <span className="text-xs font-medium text-muted-foreground/60">Set at creation</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Email</span>
              <span className="text-xs text-muted-foreground">
                {agent.email_handle ? `${agent.email_handle}@alook.ai` : "Not configured"}
              </span>
            </div>
          </div>
        )}

        {agent && (
          <CustomEmailForm
            agentId={agent.id}
            workspaceId={workspaceId}
          />
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
          <Button
            type="submit"
            size="sm"
            disabled={saving || !name || !!handleError}
          >
            {saving ? savingLabel : submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}

function WhitelistTrigger({ agentId }: { agentId: string }) {
  const { workspaceId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [whitelist, setWhitelist] = useState<WhitelistEntry[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [loadingWhitelist, setLoadingWhitelist] = useState(true);
  const [addingEmail, setAddingEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingWhitelist(true);
    listWhitelist(agentId, workspaceId)
      .then((entries) => {
        if (!cancelled) setWhitelist(entries);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load whitelist");
      })
      .finally(() => {
        if (!cancelled) setLoadingWhitelist(false);
      });
    return () => { cancelled = true; };
  }, [agentId, workspaceId, open]);

  const isValidEmail = newEmail.includes("@") && newEmail.trim().length > 0;

  const handleAdd = async () => {
    if (!isValidEmail || addingEmail) return;
    setAddingEmail(true);
    setError(null);
    try {
      const entry = await addWhitelistEmail(agentId, newEmail.toLowerCase(), workspaceId);
      setWhitelist((prev) => [...prev, entry]);
      setNewEmail("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to add email";
      setError(msg);
    } finally {
      setAddingEmail(false);
    }
  };

  const handleRemove = async (entryId: string) => {
    const prev = whitelist;
    setWhitelist((wl) => wl.filter((w) => w.id !== entryId));
    setError(null);
    try {
      await removeWhitelistEmail(agentId, entryId, workspaceId);
    } catch {
      setWhitelist(prev);
      setError("Failed to remove email");
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-lg border border-border/50 bg-muted/30 px-4 py-3 text-left transition-colors hover:bg-muted/50"
          />
        }
      >
        <div>
          <span className="text-sm font-medium">Allowed Senders</span>
          <p className="text-xs text-muted-foreground">
            {whitelist.length > 0
              ? `${whitelist.length} email${whitelist.length !== 1 ? "s" : ""} whitelisted`
              : "All inbound emails will be rejected"}
          </p>
        </div>
        <ChevronRightIcon className="size-4 text-muted-foreground" />
      </SheetTrigger>
      <SheetContent
        side="right"
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border"
      >
        <SheetTitle className="sr-only">Allowed Senders</SheetTitle>
        <SheetBody className="px-8 pt-10 pb-6">
          <div className="space-y-4">
            <div>
              <h2 className="font-heading text-lg font-semibold">Allowed Senders</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Only emails from these addresses will trigger the agent.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAdd();
                  }
                }}
                placeholder="user@example.com"
                type="email"
                className="flex-1"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!isValidEmail || addingEmail}
                onClick={handleAdd}
              >
                {addingEmail ? "Adding..." : "Add"}
              </Button>
            </div>
            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
            {loadingWhitelist ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className="block h-8 animate-pulse rounded-md bg-muted"
                  />
                ))}
              </div>
            ) : whitelist.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No allowed senders — all inbound emails will be rejected.
              </p>
            ) : (
              <div className="space-y-1.5">
                {whitelist.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2"
                  >
                    <span className="text-sm">{entry.email}</span>
                    <button
                      type="button"
                      onClick={() => handleRemove(entry.id)}
                      className="rounded-full p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
