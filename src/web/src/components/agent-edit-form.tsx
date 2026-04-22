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
  listAgentAccess,
  grantAgentAccess,
  revokeAgentAccess,
  listMembers,
  type WhitelistEntry,
  type AgentAccessEntry,
  type MemberEntry,
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
    visibility?: string;
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
  const [visibility, setVisibility] = useState(agent?.visibility ?? "private");
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
      visibility,
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
          <div className="space-y-4 rounded-lg border border-border/50 p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">Access Control</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {visibility === "public"
                    ? "All workspace members can use this agent"
                    : "Only authorized members can use this agent"}
                </p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-muted-foreground">
                  {visibility === "public" ? "Public" : "Private"}
                </span>
                <input
                  type="checkbox"
                  checked={visibility === "public"}
                  onChange={(e) => setVisibility(e.target.checked ? "public" : "private")}
                  className="sr-only peer"
                />
                <div className="relative w-9 h-5 bg-muted rounded-full peer-checked:bg-primary transition-colors">
                  <div className={cn(
                    "absolute left-0.5 top-0.5 w-4 h-4 bg-background rounded-full transition-transform",
                    visibility === "public" ? "translate-x-4" : "translate-x-0"
                  )} />
                </div>
              </label>
            </div>

            {visibility === "private" && (
              <AgentAccessList agentId={agent.id} />
            )}
          </div>
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

function AgentAccessList({ agentId }: { agentId: string }) {
  const { workspaceId } = useWorkspace();
  const [accessList, setAccessList] = useState<AgentAccessEntry[]>([]);
  const [members, setMembers] = useState<MemberEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listAgentAccess(workspaceId, agentId),
      listMembers(workspaceId),
    ])
      .then(([access, memberList]) => {
        if (!cancelled) {
          setAccessList(access);
          setMembers(memberList);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load access list");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [workspaceId, agentId]);

  const authorizedUserIds = new Set(accessList.map((e) => e.user_id));
  const availableMembers = members.filter((m) => !authorizedUserIds.has(m.user_id));

  const handleGrant = async () => {
    if (!selectedUserId || adding) return;
    setAdding(true);
    setError(null);
    try {
      await grantAgentAccess(workspaceId, agentId, selectedUserId);
      const member = members.find((m) => m.user_id === selectedUserId);
      if (member) {
        setAccessList((prev) => [
          ...prev,
          {
            id: selectedUserId,
            user_id: member.user_id,
            name: member.name,
            email: member.email,
            created_at: new Date().toISOString(),
          },
        ]);
      }
      setSelectedUserId("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to grant access");
    } finally {
      setAdding(false);
    }
  };

  const handleRevoke = async (userId: string) => {
    const prev = accessList;
    setAccessList((list) => list.filter((e) => e.user_id !== userId));
    setError(null);
    try {
      await revokeAgentAccess(workspaceId, agentId, userId);
    } catch {
      setAccessList(prev);
      setError("Failed to revoke access");
    }
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2].map((i) => (
          <span key={i} className="block h-8 animate-pulse rounded-md bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-destructive">{error}</p>}
      {accessList.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No members have been granted access.
        </p>
      ) : (
        <div className="space-y-1.5">
          {accessList.map((entry) => (
            <div
              key={entry.user_id}
              className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium truncate">{entry.name || entry.email}</p>
                {entry.name && (
                  <p className="text-xs text-muted-foreground truncate">{entry.email}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => handleRevoke(entry.user_id)}
                className="ml-2 shrink-0 rounded-full p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {availableMembers.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">Add a member...</option>
            {availableMembers.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.name || m.email}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={!selectedUserId || adding}
            onClick={handleGrant}
          >
            {adding ? "Adding..." : "Add"}
          </Button>
        </div>
      )}
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
