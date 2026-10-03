"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useEffect, useCallback } from "react";
import { useMutation, useQuery, type Query } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetTitle,
  SheetBody,
} from "@/components/ui/sheet";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  listEmailAccounts,
  createEmailAccount,
  deleteEmailAccount,
  syncEmailAccount,
} from "@/lib/api";
import type { AgentEmailAccount, CreateEmailAccountRequest } from "@alook/shared";
import {
  Loader2, Mail, RefreshCw, AlertCircle, CheckCircle2,
  ChevronRight, XIcon, CircleHelp,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceOwner, captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions, runWorkspaceRequest } from "@/contexts/workspace-context";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { isAbortError } from "@/lib/errors";
import {
  type CustomEmailErrors,
  hasCustomEmailErrors,
  validateCustomEmailFields,
} from "@/lib/form-validation";
import { trackCustomEmailConnected } from "@/lib/analytics";

const PRESETS: Record<string, { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }> = {
  Gmail: { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 587 },
  Outlook: { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp.office365.com", smtpPort: 587 },
  Yahoo: { imapHost: "imap.mail.yahoo.com", imapPort: 993, smtpHost: "smtp.mail.yahoo.com", smtpPort: 587 },
};

export type CustomEmailData = CreateEmailAccountRequest;

interface Props {
  agentId?: string;
  workspaceId: string;
  onDataChange?: (data: CustomEmailData | null) => void;
  getDataRef?: React.MutableRefObject<(() => CustomEmailData | null) | null>;
}

function useEmailFields() {
  const [emailAddress, setEmailAddress] = useAtom(useCreateAtom(""));
  const [displayName, setDisplayName] = useAtom(useCreateAtom(""));
  const [imapHost, setImapHost] = useAtom(useCreateAtom(""));
  const [imapPort, setImapPort] = useAtom(useCreateAtom(993));
  const [imapUsername, setImapUsername] = useAtom(useCreateAtom(""));
  const [imapPassword, setImapPassword] = useAtom(useCreateAtom(""));
  const [smtpHost, setSmtpHost] = useAtom(useCreateAtom(""));
  const [smtpPort, setSmtpPort] = useAtom(useCreateAtom(587));
  const [smtpUsername, setSmtpUsername] = useAtom(useCreateAtom(""));
  const [smtpPassword, setSmtpPassword] = useAtom(useCreateAtom(""));

  function applyPreset(name: string) {
    const preset = PRESETS[name];
    if (!preset) return;
    setImapHost(preset.imapHost);
    setImapPort(preset.imapPort);
    setSmtpHost(preset.smtpHost);
    setSmtpPort(preset.smtpPort);
  }

  const effectiveImapUsername = imapUsername || emailAddress;
  const effectiveSmtpUsername = smtpUsername || emailAddress;

  function buildData(): CustomEmailData | null {
    if (!emailAddress || !imapHost || !effectiveImapUsername || !imapPassword || !smtpHost || !effectiveSmtpUsername || !smtpPassword) {
      return null;
    }
    return {
      emailAddress, displayName, imapHost, imapPort,
      imapUsername: effectiveImapUsername, imapPassword,
      imapTls: true, smtpHost, smtpPort,
      smtpUsername: effectiveSmtpUsername, smtpPassword,
      smtpTls: 1, pollIntervalSeconds: 60,
    };
  }

  const fields = {
    emailAddress, setEmailAddress, displayName, setDisplayName,
    imapHost, setImapHost, imapPort, setImapPort,
    imapUsername, setImapUsername, imapPassword, setImapPassword,
    smtpHost, setSmtpHost, smtpPort, setSmtpPort,
    smtpUsername, setSmtpUsername, smtpPassword, setSmtpPassword,
  };

  return { fields, applyPreset, buildData };
}

function EmailFieldsForm({ fields, applyPreset, errors, onClearError }: {
  fields: ReturnType<typeof useEmailFields>["fields"];
  applyPreset: (name: string) => void;
  errors: CustomEmailErrors;
  onClearError: (field: keyof CustomEmailErrors) => void;
}) {
  return (
    <>
      <div className="flex gap-2">
        {Object.keys(PRESETS).map((name) => (
          <Button key={name} type="button" variant="outline" size="sm" className="h-6 text-[10px] px-2"
            onClick={() => applyPreset(name)}>
            {name}
          </Button>
        ))}
      </div>

      <div className="grid gap-3">
        <div>
          <Label className="text-xs">Email Address *</Label>
          <Input placeholder="you@gmail.com" value={fields.emailAddress}
            onChange={(e) => {
              fields.setEmailAddress(e.target.value);
              if (e.target.value.trim()) onClearError("emailAddress");
            }}
            aria-invalid={Boolean(errors.emailAddress)}
            aria-describedby={errors.emailAddress ? "custom-email-address-error" : undefined}
            className="h-8 text-sm" />
          {errors.emailAddress && (
            <p id="custom-email-address-error" className="mt-1 text-xs text-destructive">
              {errors.emailAddress}
            </p>
          )}
        </div>
        <div>
          <Label className="text-xs">Display Name</Label>
          <Input placeholder="My Agent" value={fields.displayName}
            onChange={(e) => fields.setDisplayName(e.target.value)} className="h-8 text-sm" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-xs font-medium">IMAP (Receive)</Label>
          <Input placeholder="imap.gmail.com" value={fields.imapHost}
            onChange={(e) => {
              fields.setImapHost(e.target.value);
              if (e.target.value.trim()) onClearError("imapHost");
            }}
            aria-invalid={Boolean(errors.imapHost)}
            aria-describedby={errors.imapHost ? "custom-email-imap-host-error" : undefined}
            className="h-8 text-sm" />
          {errors.imapHost && (
            <p id="custom-email-imap-host-error" className="text-xs text-destructive">
              {errors.imapHost}
            </p>
          )}
          <Input type="number" placeholder="993" value={fields.imapPort}
            onChange={(e) => fields.setImapPort(Number(e.target.value))} className="h-8 text-sm" />
          <Input placeholder={fields.emailAddress || "Username (defaults to email)"} value={fields.imapUsername}
            onChange={(e) => fields.setImapUsername(e.target.value)} className="h-8 text-sm" />
          <Input type="password" placeholder="App Password" value={fields.imapPassword}
            onChange={(e) => {
              fields.setImapPassword(e.target.value);
              if (e.target.value.trim()) onClearError("imapPassword");
            }}
            aria-invalid={Boolean(errors.imapPassword)}
            aria-describedby={errors.imapPassword ? "custom-email-imap-password-error" : undefined}
            className="h-8 text-sm" />
          {errors.imapPassword && (
            <p id="custom-email-imap-password-error" className="text-xs text-destructive">
              {errors.imapPassword}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label className="text-xs font-medium">SMTP (Send)</Label>
          <Input placeholder="smtp.gmail.com" value={fields.smtpHost}
            onChange={(e) => {
              fields.setSmtpHost(e.target.value);
              if (e.target.value.trim()) onClearError("smtpHost");
            }}
            aria-invalid={Boolean(errors.smtpHost)}
            aria-describedby={errors.smtpHost ? "custom-email-smtp-host-error" : undefined}
            className="h-8 text-sm" />
          {errors.smtpHost && (
            <p id="custom-email-smtp-host-error" className="text-xs text-destructive">
              {errors.smtpHost}
            </p>
          )}
          <Input type="number" placeholder="587" value={fields.smtpPort}
            onChange={(e) => fields.setSmtpPort(Number(e.target.value))} className="h-8 text-sm" />
          <Input placeholder={fields.emailAddress || "Username (defaults to email)"} value={fields.smtpUsername}
            onChange={(e) => fields.setSmtpUsername(e.target.value)} className="h-8 text-sm" />
          <Input type="password" placeholder="App Password" value={fields.smtpPassword}
            onChange={(e) => {
              fields.setSmtpPassword(e.target.value);
              if (e.target.value.trim()) onClearError("smtpPassword");
            }}
            aria-invalid={Boolean(errors.smtpPassword)}
            aria-describedby={errors.smtpPassword ? "custom-email-smtp-password-error" : undefined}
            className="h-8 text-sm" />
          {errors.smtpPassword && (
            <p id="custom-email-smtp-password-error" className="text-xs text-destructive">
              {errors.smtpPassword}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

export function CustomEmailForm({ agentId, workspaceId, onDataChange, getDataRef }: Props) {
  const owner = useWorkspaceOwner();
  const { slug } = owner;
  const isCreateMode = !agentId;
  const [open, setOpen] = useAtom(useCreateAtom(false));
  const source = useWorkspaceViewSource(owner, `custom-email:${agentId ?? "create"}`, open);
  const formSource = useWorkspaceViewSource(owner, `custom-email-draft:${agentId ?? "create"}`, true);
  const changeOpen = (next: boolean) => { if (!next) source.retire(); setOpen(next); };
  const [fieldErrors, setFieldErrors] = useAtom(useCreateAtom<CustomEmailErrors>({}));
  const queryKey = owner.key("email-accounts", agentId);
  const accountsQuery = useQuery({ queryKey, enabled: !!agentId && owner.workspaceId === workspaceId, subscribed: !!agentId && owner.workspaceId === workspaceId,
    queryFn: ({ signal }) => runWorkspaceRequest(owner, (options) => listEmailAccounts(agentId!, workspaceId, options), signal),
  });
  type Command = { kind: "create"; data: CustomEmailData } | { kind: "delete" | "sync"; id: string };
  const command = useMutation({ mutationKey: [...queryKey, "command"], scope: { id: JSON.stringify(queryKey) },
    gcTime: 0,
    mutationFn: async ({ action, token, assertView, signal, resource: original }: { action: Command; token: ReturnType<typeof captureWorkspaceOwner>; assertView: () => void; signal: AbortSignal; resource: Query | undefined }) => {
      const assert = () => { assertWorkspaceOwner(token, signal); assertView(); };
      assert();
      if (!agentId || owner.workspaceId !== workspaceId) throw new DOMException("Retired email scope", "AbortError");
      if (original && owner.queryClient.getQueryCache().find({ queryKey, exact: true }) === original) await owner.queryClient.cancelQueries({ queryKey, exact: true });
      assert();
      const canPublish = () => original && owner.queryClient.getQueryCache().find({ queryKey, exact: true }) === original;
      const options = workspaceRequestOptions(token, signal, assert);
      try {
        if (action.kind === "create") {
          const account = await createEmailAccount(agentId, action.data, workspaceId, options);
          assert();
          if (canPublish()) owner.queryClient.setQueryData<AgentEmailAccount[]>(queryKey, (rows) => rows ? [...rows.filter((row) => row.id !== account.id), account] : rows);
        } else if (action.kind === "delete") {
          await deleteEmailAccount(agentId, action.id, workspaceId, options);
          assert();
          if (canPublish()) owner.queryClient.setQueryData<AgentEmailAccount[]>(queryKey, (rows) => rows?.filter((row) => row.id !== action.id));
        } else await syncEmailAccount(agentId, action.id, workspaceId, options);
        assert();
        if (canPublish()) void owner.queryClient.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false }).catch(() => undefined);
        assert();
      } catch (error) { assert(); throw error; }
    },
  });
  const accounts = accountsQuery.data ?? [];
  const loading = !isCreateMode && accountsQuery.isPending;
  const saving = command.isPending && command.variables?.action.kind === "create";
  const syncing = command.isPending && command.variables?.action.kind === "sync";
  const deleting = command.isPending && command.variables?.action.kind === "delete";

  const { fields, applyPreset, buildData } = useEmailFields();
  const effectiveImapUsername = fields.imapUsername || fields.emailAddress;
  const effectiveSmtpUsername = fields.smtpUsername || fields.emailAddress;

  const clearFieldError = useCallback((field: keyof CustomEmailErrors) => {
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  }, [setFieldErrors]);

  useEffect(() => {
    if (!getDataRef) return;
    const get = () => { formSource.capture().assert(); return buildData(); };
    getDataRef.current = get;
    return () => { if (getDataRef.current === get) getDataRef.current = null; };
  }, [getDataRef, buildData, formSource.assertActive, formSource]);

  useEffect(() => {
    if (!isCreateMode) return;
    formSource.capture().assert();
    onDataChange?.(buildData());
  }, [isCreateMode, buildData, onDataChange, fields.emailAddress, fields.displayName, fields.imapHost, fields.imapPort, fields.imapUsername, fields.imapPassword, fields.smtpHost, fields.smtpPort, fields.smtpUsername, fields.smtpPassword, formSource]);



  const existing = accounts[0] ?? null;

  async function handleCreate() {
    const nextErrors = validateCustomEmailFields({
      emailAddress: fields.emailAddress,
      imapHost: fields.imapHost,
      imapUsername: effectiveImapUsername,
      imapPassword: fields.imapPassword,
      smtpHost: fields.smtpHost,
      smtpUsername: effectiveSmtpUsername,
      smtpPassword: fields.smtpPassword,
    });
    setFieldErrors(nextErrors);
    if (hasCustomEmailErrors(nextErrors)) return;

    const data = buildData();
    if (!data) return;
    if (!agentId) return;
    const assertView = source.assertActive;
    assertView();
    if (owner.queryClient.getMutationCache().findAll({ mutationKey: [...queryKey, "command"], status: "pending" }).length) return;
    try {
      await command.mutateAsync({ action: { kind: "create", data }, token: captureWorkspaceOwner(owner), assertView, signal: source.signal, resource: owner.queryClient.getQueryCache().find({ queryKey, exact: true }) });
      assertView();
      const domain = data.emailAddress.split("@")[1] ?? "";
      trackCustomEmailConnected({ email_domain: domain });
      toast.success("Custom email configured");
      fields.setImapPassword("");
      fields.setSmtpPassword("");
      changeOpen(false);
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error(error instanceof Error ? error.message : "Failed to save");
    }
  }

  async function handleDelete() {
    if (!existing || !agentId) return;
    const assertView = source.assertActive;
    assertView();
    if (owner.queryClient.getMutationCache().findAll({ mutationKey: [...queryKey, "command"], status: "pending" }).length) return;
    try {
      await command.mutateAsync({ action: { kind: "delete", id: existing.id }, token: captureWorkspaceOwner(owner), assertView, signal: source.signal, resource: owner.queryClient.getQueryCache().find({ queryKey, exact: true }) });
      assertView();
      toast.success("Custom email removed");
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error(error instanceof Error ? error.message : "Failed to remove");
    }
  }

  async function handleSync() {
    if (!existing || !agentId) return;
    const assertView = source.assertActive;
    assertView();
    if (owner.queryClient.getMutationCache().findAll({ mutationKey: [...queryKey, "command"], status: "pending" }).length) return;
    try {
      await command.mutateAsync({ action: { kind: "sync", id: existing.id }, token: captureWorkspaceOwner(owner), assertView, signal: source.signal, resource: owner.queryClient.getQueryCache().find({ queryKey, exact: true }) });
      assertView();
      toast.success("Sync triggered");
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error(error instanceof Error ? error.message : "Sync failed");
    }
  }


  const triggerDesc = isCreateMode
    ? (fields.emailAddress
      ? fields.emailAddress
      : "Connect your own mailbox via IMAP/SMTP")
    : loading
      ? "Loading..."
      : existing
        ? existing.email_address
        : "Connect your own mailbox via IMAP/SMTP";

  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-lg border border-border/50 bg-muted/30 px-4 py-3 text-left transition-colors hover:bg-muted/50"
          />
        }
      >
        <div>
          <span className="text-sm font-medium">Custom Email</span>
          <p className="text-xs text-muted-foreground">{triggerDesc}</p>
        </div>
        {!isCreateMode && existing ? (
          <span className={cn(
            "inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-full font-medium shrink-0",
            existing.status === "active" ? "bg-green-500/10 text-green-600" :
            existing.status === "error" ? "bg-red-500/10 text-red-600" :
            "bg-yellow-500/10 text-yellow-600"
          )}>
            {existing.status === "active" ? <CheckCircle2 className="size-2.5" /> :
             existing.status === "error" ? <AlertCircle className="size-2.5" /> : null}
            {existing.status}
          </span>
        ) : (
          <ChevronRight className="size-4 text-muted-foreground shrink-0" />
        )}
      </SheetTrigger>
      <SheetContent
        side="right"
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border"
      >
        <SheetTitle className="sr-only">Custom Email</SheetTitle>
        <SheetBody className="px-8 pt-10 pb-6">
          <div className="space-y-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-heading text-lg font-semibold">Custom Email</h2>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <a
                        href={`/w/${slug}/help/email-setup`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground transition-colors"
                      />
                    }
                  >
                    <CircleHelp className="size-4" />
                  </TooltipTrigger>
                  <TooltipContent>How to get IMAP/SMTP credentials</TooltipContent>
                </Tooltip>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Connect your own mailbox to send and receive email as your identity.
              </p>
            </div>

            {!isCreateMode && accountsQuery.isError ? <div role="alert" className="space-y-3">
              <p className="text-sm">Couldn’t load email accounts.</p>
              <Button variant="outline" onClick={() => { source.assertActive(); void accountsQuery.refetch({ cancelRefetch: false }); }}>Try again</Button>
            </div> : !isCreateMode && loading ? <Loader2 className="size-4 animate-spin" /> : !isCreateMode && existing ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Mail className="size-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm truncate">{existing.email_address}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={handleSync}
                            disabled={syncing}
                            className="rounded-full text-muted-foreground"
                          />
                        }
                      >
                        <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
                      </TooltipTrigger>
                      <TooltipContent>Sync now</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={handleDelete}
                            disabled={deleting}
                            className="rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          />
                        }
                      >
                        {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <XIcon className="size-3.5" />}
                      </TooltipTrigger>
                      <TooltipContent>Remove</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                {existing.error_message && (
                  <p className="text-xs text-destructive">{existing.error_message}</p>
                )}
                {existing.last_synced_at && (
                  <p className="text-xs text-muted-foreground">
                    Last synced: {new Date(existing.last_synced_at).toLocaleString()}
                  </p>
                )}
                <div className="rounded-md border border-border/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
                  <div className="flex justify-between"><span>IMAP</span><span>{existing.imap_host}:{existing.imap_port}</span></div>
                  <div className="flex justify-between"><span>SMTP</span><span>{existing.smtp_host}:{existing.smtp_port}</span></div>
                  <div className="flex justify-between"><span>Poll interval</span><span>{existing.poll_interval_seconds}s</span></div>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <EmailFieldsForm
                  fields={fields}
                  applyPreset={applyPreset}
                  errors={fieldErrors}
                  onClearError={clearFieldError}
                />
                {!isCreateMode && (
                  <Button type="button" size="sm" className="w-full" onClick={handleCreate} disabled={saving}>
                    {saving && <Loader2 className="size-3 animate-spin mr-1" />}
                    Save & Connect
                  </Button>
                )}
                {isCreateMode && (
                  <p className="text-xs text-muted-foreground">
                    Will be connected after creating the agent.
                  </p>
                )}
              </div>
            )}
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
