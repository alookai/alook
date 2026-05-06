"use client";

import { useState, useEffect, useCallback } from "react";
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
import { useWorkspace } from "@/contexts/workspace-context";
import {
  type CustomEmailErrors,
  hasCustomEmailErrors,
  validateCustomEmailFields,
} from "@/lib/form-validation";

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
  const [emailAddress, setEmailAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);
  const [imapUsername, setImapUsername] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");

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
      <div className="flex gap-1.5">
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
  const { slug } = useWorkspace();
  const isCreateMode = !agentId;
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<AgentEmailAccount[]>([]);
  const [loading, setLoading] = useState(!isCreateMode);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<CustomEmailErrors>({});

  const { fields, applyPreset, buildData } = useEmailFields();
  const effectiveImapUsername = fields.imapUsername || fields.emailAddress;
  const effectiveSmtpUsername = fields.smtpUsername || fields.emailAddress;

  const clearFieldError = useCallback((field: keyof CustomEmailErrors) => {
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  }, []);

  useEffect(() => {
    if (getDataRef) getDataRef.current = buildData;
  });

  useEffect(() => {
    if (!isCreateMode) return;
    onDataChange?.(buildData());
  }, [
    isCreateMode,
    buildData,
    onDataChange,
    fields.emailAddress, fields.displayName,
    fields.imapHost, fields.imapPort, fields.imapUsername, fields.imapPassword,
    fields.smtpHost, fields.smtpPort, fields.smtpUsername, fields.smtpPassword,
  ]);

  const load = useCallback(async () => {
    if (isCreateMode) return;
    try {
      const list = await listEmailAccounts(agentId!, workspaceId);
      setAccounts(list);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [agentId, workspaceId, isCreateMode]);

  useEffect(() => { load(); }, [load]);

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
    setSaving(true);
    try {
      await createEmailAccount(agentId, data, workspaceId);
      toast.success("Custom email configured");
      setOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!existing || !agentId) return;
    setDeleting(true);
    try {
      await deleteEmailAccount(agentId, existing.id, workspaceId);
      toast.success("Custom email removed");
      setAccounts([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setDeleting(false);
    }
  }

  async function handleSync() {
    if (!existing || !agentId) return;
    setSyncing(true);
    try {
      await syncEmailAccount(agentId, existing.id, workspaceId);
      toast.success("Sync triggered");
      setTimeout(() => load(), 2000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
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
          <span className="text-sm font-medium">Custom Email</span>
          <p className="text-xs text-muted-foreground">{triggerDesc}</p>
        </div>
        {!isCreateMode && existing ? (
          <span className={cn(
            "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0",
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
                <a
                  href={`/w/${slug}/help/email-setup`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  title="How to get IMAP/SMTP credentials"
                >
                  <CircleHelp className="size-4" />
                </a>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Connect your own mailbox to send and receive email as your identity.
              </p>
            </div>

            {!isCreateMode && existing ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <Mail className="size-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm truncate">{existing.email_address}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={handleSync}
                      disabled={syncing}
                      title="Sync now"
                      className="rounded-full p-1 text-muted-foreground hover:bg-muted transition-colors"
                    >
                      <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      title="Remove"
                      className="rounded-full p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                    >
                      {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <XIcon className="size-3.5" />}
                    </button>
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
