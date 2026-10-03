"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { onEnterSubmit } from "@/lib/ime";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { RuntimeSelect } from "@/components/runtime-select";
import { ProviderLogo } from "@/components/provider-logo";
import { isValidHandle, isPublic, isPrivate } from "@alook/shared";
import type { AgentRuntime as Runtime } from "@alook/shared";
import { cn } from "@/lib/utils";
import { InfoIcon, XIcon, Dices, ChevronDown } from "lucide-react";
import { useWorkspaceOwner, captureWorkspaceOwner } from "@/contexts/workspace-context";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { agentWhitelistOptions, agentAccessOptions, workspaceMembersOptions } from "@/hooks/workspace/settings-query-options";
import { useAgentPermissionCommand, usePendingAgentPermissions } from "@/hooks/workspace/use-agent-permission-command";
import { type AgentAccessEntry } from "@/lib/api";
import { isAbortError } from "@/lib/errors";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea";

export function nameToHandle(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// --- General Fields ---

interface GeneralFieldsProps {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  instructions?: string;
  setInstructions?: (v: string) => void;
  model: string;
  setModel: (v: string) => void;
  runtimeId: string;
  setRuntimeId: (v: string) => void;
  runtimes: Runtime[];
  providerModels: string[];
  errors?: {
    name?: string;
    runtimeId?: string;
  };
  runtimeAsRadio?: boolean;
  onShuffle?: () => void;
  emailHandleSlot?: React.ReactNode;
  advancedSection?: React.ReactNode;
}

export function GeneralFields({
  name,
  setName,
  description,
  setDescription,
  instructions,
  setInstructions,
  model,
  setModel,
  runtimeId,
  setRuntimeId,
  runtimes,
  providerModels,
  errors,
  runtimeAsRadio = false,
  onShuffle,
  emailHandleSlot,
  advancedSection,
}: GeneralFieldsProps) {
  return (
    <>
      {/* Name — large frameless input */}
      <div>
        <div className="relative">
          <input
            id="agent-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Agent name"
            required
            autoFocus
            aria-invalid={Boolean(errors?.name)}
            aria-describedby={errors?.name ? "agent-name-error" : undefined}
            className="w-full border-0 bg-transparent px-0 py-1 text-2xl font-medium leading-[1.2] tracking-tight shadow-none outline-none placeholder:text-muted-foreground/40 placeholder:font-normal focus-visible:ring-0"
          />
          {onShuffle && (
            <button
              type="button"
              onClick={onShuffle}
              aria-label="Randomize name"
              className="absolute right-0 top-1/2 -translate-y-1/2 rounded p-2 text-muted-foreground/50 hover:text-foreground hover:bg-accent transition-colors"
            >
              <Dices className="size-4" />
            </button>
          )}
        </div>
        {errors?.name && (
          <p id="agent-name-error" className="text-xs text-destructive mt-1">
            {errors.name}
          </p>
        )}
      </div>

      {/* Description — frameless, auto-growing */}
      <AutoResizeTextarea
        id="agent-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Add a description…"
        rows={1}
        className="w-full border-0 bg-transparent px-0 py-1 text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0"
      />

      {emailHandleSlot}

      {/* Runtime */}
      {(runtimeAsRadio || runtimes.length > 0) && <div id="agent-runtime-select" className="space-y-2">
        <Label className="text-xs text-muted-foreground">Runtime</Label>
        {runtimeAsRadio ? (
          <div className="space-y-2" role="radiogroup" aria-label="Runtime">
            {runtimes.length === 0 ? (
              <p className="text-xs text-muted-foreground">No runtimes — start a daemon first</p>
            ) : (
              runtimes.map((rt) => {
                const isOnline = rt.status === "online";
                const isSelected = runtimeId === rt.id;
                const machine = typeof rt.device_info === "string" ? rt.device_info : "";
                return (
                  <label
                    key={rt.id}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border p-2 cursor-pointer transition-colors",
                      isSelected
                        ? "border-primary bg-primary/5"
                        : "border-border/50 hover:border-foreground/20",
                      !isOnline && "opacity-40 pointer-events-none"
                    )}
                  >
                    <input
                      type="radio"
                      name="runtime"
                      value={rt.id}
                      checked={isSelected}
                      disabled={!isOnline}
                      onChange={() => {
                        const oldProvider = runtimes.find((r) => r.id === runtimeId)?.provider;
                        const newProvider = rt.provider;
                        setRuntimeId(rt.id);
                        if (oldProvider && oldProvider !== newProvider) {
                          setModel("");
                        }
                      }}
                      className="accent-primary size-3.5"
                    />
                    <ProviderLogo provider={rt.provider} className="h-4 w-4 shrink-0" />
                    <span className="text-sm">{rt.provider}</span>
                    {machine && (
                      <span className="text-xs text-muted-foreground">{machine}</span>
                    )}
                    {!isOnline && (
                      <span className="text-xs text-muted-foreground ml-auto">offline</span>
                    )}
                  </label>
                );
              })
            )}
          </div>
        ) : (
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
            triggerProps={{
              "aria-invalid": Boolean(errors?.runtimeId),
              "aria-describedby": errors?.runtimeId
                ? "agent-runtime-error"
                : undefined,
            }}
          />
        )}
        {errors?.runtimeId && (
          <p id="agent-runtime-error" className="text-xs text-destructive">
            {errors.runtimeId}
          </p>
        )}
      </div>}

      {/* Advanced — collapsible */}
      {(setInstructions || advancedSection) && (
        <AdvancedSection>
          {setInstructions && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Instructions</Label>
              <AutoResizeTextarea
                id="agent-instructions"
                value={instructions ?? ""}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="System prompt or instructions..."
                rows={3}
                className="w-full border-0 bg-transparent px-0 py-1 text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0"
              />
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Model</Label>
            <input
              id="agent-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Default (runtime model)"
              list="agent-model-options"
              className="w-full border-0 bg-transparent px-0 py-1 text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0"
            />
            {providerModels.length > 0 && (
              <datalist id="agent-model-options">
                {providerModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
          </div>

          {advancedSection}
        </AdvancedSection>
      )}
    </>
  );
}

// --- Advanced Section (collapsible) ---

function AdvancedSection({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useAtom(useCreateAtom(false));
  return (
    <div className="pt-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        Advanced
      </button>
      {open && <div className="mt-3 space-y-4">{children}</div>}
    </div>
  );
}

// --- Email Handle Field ---

interface EmailHandleFieldProps {
  emailHandle: string;
  setEmailHandle: (v: string) => void;
  derivedHandle: string;
}

export function EmailHandleField({
  emailHandle,
  setEmailHandle,
  derivedHandle,
}: EmailHandleFieldProps) {
  const effectiveHandle = emailHandle || derivedHandle;
  const handleError =
    effectiveHandle && !isValidHandle(effectiveHandle)
      ? "Must be 3+ characters, letters/numbers/hyphens only"
      : "";

  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">Email</Label>
      <div className="flex items-center">
        <input
          id="agent-handle"
          value={emailHandle}
          onChange={(e) => setEmailHandle(e.target.value.toLowerCase())}
          placeholder={derivedHandle || "my-agent"}
          className="w-full border-0 bg-transparent px-0 py-1 text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0"
        />
        <span className="shrink-0 text-sm text-muted-foreground/70">
          @alook.ai
        </span>
      </div>
      {handleError && (
        <p className="text-xs text-destructive">{handleError}</p>
      )}
    </div>
  );
}

export function getHandleError(effectiveHandle: string): string {
  if (effectiveHandle && !isValidHandle(effectiveHandle)) {
    return "Must be 3+ characters, letters/numbers/hyphens only";
  }
  return "";
}


// --- Allowed Senders (inline tab content) ---

export function AllowedSendersTab({ agentId }: { agentId: string }) {
  const owner = useWorkspaceOwner();
  const { agents } = useAgentContext();
  const source = useWorkspaceViewSource(owner, `whitelist:${agentId}`, true);
  const query = useQuery(agentWhitelistOptions(owner, agentId));
  const command = useAgentPermissionCommand(owner, agentId);
  const pending = usePendingAgentPermissions(owner, agentId);
  const removed = new Set(pending.flatMap((action) => action.kind === "whitelist-remove" ? [action.id] : []));
  const whitelist = (query.data ?? []).filter((entry) => !removed.has(entry.id));
  const [newEmail, setNewEmail] = useAtom(useCreateAtom(""));
  const [actionError, setActionError] = useAtom(useCreateAtom<string | null>(null));
  const loading = query.isPending;
  const adding = pending.some((action) => action.kind === "whitelist-add");
  const error = actionError ?? query.error?.message ?? null;
  const hasSiblingAgents = agents.some((agent) => agent.id !== agentId && !!agent.email_handle);
  const isValidEmail = newEmail.includes("@") && newEmail.trim().length > 0;
  const handleAdd = async () => {
    if (!isValidEmail || adding) return;
    const assertView = source.assertActive;
    setActionError(null);
    try {
      await command.mutateAsync({ action: { kind: "whitelist-add", email: newEmail.toLowerCase() }, token: captureWorkspaceOwner(owner), assertActive: Object.assign(() => assertView(), { signal: source.signal }) });
      assertView();
      setNewEmail("");
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) setActionError(error instanceof Error ? error.message : "Failed to add email");
    }
  };
  const handleRemove = async (id: string) => {
    const assertView = source.assertActive;
    setActionError(null);
    try {
      await command.mutateAsync({ action: { kind: "whitelist-remove", id }, token: captureWorkspaceOwner(owner), assertActive: Object.assign(() => assertView(), { signal: source.signal }) });
      assertView();
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) setActionError("Failed to remove email");
    }
  };


  return (
    <div className="mx-auto max-w-md space-y-4">
      <div>
        <h3 className="text-sm font-medium">Allowed Senders</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Only emails from these addresses will trigger this agent. Applies to
          all configured email addresses (alook.ai handle and custom email).
        </p>
        {hasSiblingAgents && (
          <p className="text-xs text-muted-foreground/70 mt-2 flex items-center gap-1">
            <InfoIcon className="size-3 shrink-0" />
            Agents in this workspace can already email each other — no whitelist
            entry needed.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={onEnterSubmit(handleAdd)}
          placeholder="user@example.com"
          type="email"
          className="flex-1"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!isValidEmail || adding}
          onClick={handleAdd}
        >
          {adding ? "Adding..." : "Add"}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {loading ? (
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
        <div className="space-y-2">
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
  );
}

// --- Agent Access Tab ---

export function AgentAccessTab({
  agentId,
  ownerId,
}: {
  agentId: string;
  ownerId: string | null;
}) {
  const owner = useWorkspaceOwner();
  const { agents } = useAgentContext();
  const source = useWorkspaceViewSource(owner, `agent-access:${agentId}`, true);
  const access = useQuery(agentAccessOptions(owner, agentId));
  const memberQuery = useQuery(workspaceMembersOptions(owner));
  const command = useAgentPermissionCommand(owner, agentId);
  const pending = usePendingAgentPermissions(owner, agentId);
  const [actionError, setActionError] = useAtom(useCreateAtom<string | null>(null));
  const [selectedUserId, setSelectedUserId] = useAtom(useCreateAtom(""));
  const [revokeUserId, setRevokeUserId] = useAtom(useCreateAtom<string | null>(null));
  const [removeWhitelist, setRemoveWhitelist] = useAtom(useCreateAtom(true));
  const members = memberQuery.data ?? [];
  const removed = new Set(pending.flatMap((action) => action.kind === "revoke" ? [action.userId] : []));
  const accessList = (access.data ?? []).filter((entry) => !removed.has(entry.user_id));
  const revokeTarget = access.data?.find((entry) => entry.user_id === revokeUserId) ?? null;
  const setRevokeTarget = (entry: AgentAccessEntry | null) => setRevokeUserId(entry?.user_id ?? null);
  const visibilityIntent = pending.findLast((action) => action.kind === "visibility");
  const visibility = visibilityIntent?.kind === "visibility" ? visibilityIntent.value : agents.find((agent) => agent.id === agentId)?.visibility ?? "private";
  const savingVisibility = pending.some((action) => action.kind === "visibility");
  const adding = pending.some((action) => action.kind === "grant");
  const loading = access.isPending || memberQuery.isPending;
  const error = actionError ?? access.error?.message ?? memberQuery.error?.message ?? null;
  const ownerMember = members.find((member) => member.user_id === ownerId);
  const authorizedUserIds = new Set(accessList.map((entry) => entry.user_id));
  for (const action of pending) if (action.kind === "grant") authorizedUserIds.add(action.userId);
  const availableMembers = members.filter((member) => !authorizedUserIds.has(member.user_id) && member.user_id !== ownerId);
  const handleVisibilityChange = async (value: string) => {
    const assertView = source.assertActive;
    try {
      await command.mutateAsync({ action: { kind: "visibility", value }, token: captureWorkspaceOwner(owner), assertActive: Object.assign(() => assertView(), { signal: source.signal }) });
      assertView();
      toast.success(isPublic(value) ? "Agent is now public" : "Agent is now private");
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error("Failed to update visibility");
    }
  };
  const handleGrant = async (userId: string) => {
    if (!userId || adding) return;
    const assertView = source.assertActive;
    setActionError(null);
    try {
      await command.mutateAsync({ action: { kind: "grant", userId }, token: captureWorkspaceOwner(owner), assertActive: Object.assign(() => assertView(), { signal: source.signal }) });
      assertView();
      setSelectedUserId("");
      toast.success("Access granted");
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) setActionError(error instanceof Error ? error.message : "Failed to grant access");
    }
  };
  const handleRevoke = (userId: string) => { setRevokeUserId(userId); setRemoveWhitelist(true); };
  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    const userId = revokeTarget.user_id, remove = removeWhitelist, assertView = source.assertActive;
    setRevokeUserId(null);
    setActionError(null);
    try {
      await command.mutateAsync({ action: { kind: "revoke", userId, removeWhitelist: remove }, token: captureWorkspaceOwner(owner), assertActive: Object.assign(() => assertView(), { signal: source.signal }) });
      assertView();
      toast.success(remove ? "Access revoked and removed from whitelist" : "Access revoked");
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) setActionError("Failed to revoke access");
    }
  };


  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="space-y-4 rounded-lg border border-border/50 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">Visibility</h3>
            <p className="text-xs text-muted-foreground mt-1">
              {isPublic(visibility)
                ? "All workspace members can use this agent"
                : "Only authorized members can use this agent"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {savingVisibility
                ? "Saving…"
                : isPublic(visibility)
                  ? "Public"
                  : "Private"}
            </span>
            <Switch
              checked={isPublic(visibility)}
              onCheckedChange={(checked) =>
                handleVisibilityChange(checked ? "public" : "private")
              }
              disabled={savingVisibility}
            />
          </div>
        </div>
      </div>

      {isPrivate(visibility) && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Authorized Members</h3>
          {error && <p className="text-xs text-destructive">{error}</p>}

          {loading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <span
                  key={i}
                  className="block h-10 animate-pulse rounded-md bg-muted"
                />
              ))}
            </div>
          ) : (
            <>
              <div className="space-y-2">
                {ownerMember && (
                  <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">
                        {ownerMember.name || ownerMember.email}
                      </p>
                      {ownerMember.name && (
                        <p className="text-xs text-muted-foreground truncate">
                          {ownerMember.email}
                        </p>
                      )}
                    </div>
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      Owner
                    </span>
                  </div>
                )}
                {accessList.map((entry) => (
                  <div
                    key={entry.user_id}
                    className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">
                        {entry.name || entry.email}
                      </p>
                      {entry.name && (
                        <p className="text-xs text-muted-foreground truncate">
                          {entry.email}
                        </p>
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

              {availableMembers.length > 0 ? (
                <div className="flex items-center gap-2">
                  <Select
                    value={selectedUserId}
                    onValueChange={(val) => {
                      if (!val) return;
                      setSelectedUserId(val);
                      handleGrant(val);
                    }}
                  >
                    <SelectTrigger className="flex-1 text-xs">
                      <SelectValue placeholder="Add a member..." />
                    </SelectTrigger>
                    <SelectContent>
                      {availableMembers.map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          {m.name || m.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  All workspace members have been added. Invite new members from workspace settings.
                </p>
              )}
            </>
          )}
        </div>
      )}

      <Dialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Member Access</DialogTitle>
            <DialogDescription>
              Remove{" "}
              <span className="font-medium text-foreground">
                {revokeTarget?.name || revokeTarget?.email}
              </span>{" "}
              from this agent?
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 cursor-pointer px-1">
            <input
              type="checkbox"
              checked={removeWhitelist}
              onChange={(e) => setRemoveWhitelist(e.target.checked)}
              className="size-4 rounded border-border accent-primary"
            />
            <span className="text-sm">Also remove from email whitelist</span>
          </label>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </DialogClose>
            <Button size="sm" variant="destructive" onClick={confirmRevoke}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
