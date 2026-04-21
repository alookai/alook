"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  listEmailAccounts,
  createEmailAccount,
  deleteEmailAccount,
  syncEmailAccount,
} from "@/lib/api";
import type { AgentEmailAccount, CreateEmailAccountRequest } from "@alook/shared";
import { Loader2, Mail, RefreshCw, Trash2, AlertCircle, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

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
}

export function CustomEmailForm({ agentId, workspaceId, onDataChange }: Props) {
  const isCreateMode = !agentId;
  const [accounts, setAccounts] = useState<AgentEmailAccount[]>([]);
  const [loading, setLoading] = useState(!isCreateMode);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  const buildData = useCallback((): CustomEmailData | null => {
    if (!emailAddress || !imapHost || !imapUsername || !imapPassword || !smtpHost || !smtpUsername || !smtpPassword) {
      return null;
    }
    return {
      emailAddress,
      displayName,
      imapHost,
      imapPort,
      imapUsername,
      imapPassword,
      imapTls: true,
      smtpHost,
      smtpPort,
      smtpUsername,
      smtpPassword,
      smtpTls: 1,
      pollIntervalSeconds: 60,
    };
  }, [emailAddress, displayName, imapHost, imapPort, imapUsername, imapPassword, smtpHost, smtpPort, smtpUsername, smtpPassword]);

  useEffect(() => {
    if (!isCreateMode) return;
    onDataChange?.(expanded ? buildData() : null);
  }, [isCreateMode, expanded, buildData, onDataChange]);

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
    const data = buildData();
    if (!data) {
      toast.error("Please fill in all required fields");
      return;
    }
    if (!agentId) return;
    setSaving(true);
    try {
      await createEmailAccount(agentId, data, workspaceId);
      toast.success("Custom email configured");
      setExpanded(false);
      await load();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to save");
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
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to remove");
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
    } catch (err: any) {
      toast.error(err?.message ?? "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  function applyPreset(name: string) {
    const preset = PRESETS[name];
    if (!preset) return;
    setImapHost(preset.imapHost);
    setImapPort(preset.imapPort);
    setSmtpHost(preset.smtpHost);
    setSmtpPort(preset.smtpPort);
  }

  if (loading) {
    return (
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Custom Email</Label>
        <div className="h-8 bg-muted/30 rounded animate-pulse" />
      </div>
    );
  }

  if (!isCreateMode && existing) {
    return (
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Custom Email</Label>
        <div className="rounded-lg border border-border/50 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <Mail className="size-3.5 text-muted-foreground shrink-0" />
              <span className="text-sm truncate">{existing.email_address}</span>
              <span className={cn(
                "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                existing.status === "active" ? "bg-green-500/10 text-green-600" :
                existing.status === "error" ? "bg-red-500/10 text-red-600" :
                "bg-yellow-500/10 text-yellow-600"
              )}>
                {existing.status === "active" ? <CheckCircle2 className="size-2.5" /> :
                 existing.status === "error" ? <AlertCircle className="size-2.5" /> : null}
                {existing.status}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button variant="ghost" size="icon-sm" onClick={handleSync} disabled={syncing} title="Sync now">
                <RefreshCw className={cn("size-3", syncing && "animate-spin")} />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={handleDelete} disabled={deleting} title="Remove"
                className="hover:text-destructive">
                {deleting ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
              </Button>
            </div>
          </div>
          {existing.error_message && (
            <p className="text-xs text-red-500 break-all">{existing.error_message}</p>
          )}
          {existing.last_synced_at && (
            <p className="text-[10px] text-muted-foreground">
              Last synced: {new Date(existing.last_synced_at).toLocaleString()}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        Custom Email (IMAP/SMTP)
        {!expanded && emailAddress && (
          <span className="text-muted-foreground/70 ml-1">&mdash; {emailAddress}</span>
        )}
      </button>

      {expanded && (
        <div className="rounded-lg border border-border/50 p-3 space-y-3">
          <div className="flex gap-1.5">
            {Object.keys(PRESETS).map((name) => (
              <Button key={name} type="button" variant="outline" size="sm" className="h-6 text-[10px] px-2"
                onClick={() => applyPreset(name)}>
                {name}
              </Button>
            ))}
          </div>

          <div className="grid gap-2">
            <div>
              <Label className="text-xs">Email Address *</Label>
              <Input placeholder="you@gmail.com" value={emailAddress}
                onChange={(e) => setEmailAddress(e.target.value)} className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs">Display Name</Label>
              <Input placeholder="My Agent" value={displayName}
                onChange={(e) => setDisplayName(e.target.value)} className="h-8 text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label className="text-xs font-medium">IMAP (Receive)</Label>
              <Input placeholder="imap.gmail.com" value={imapHost}
                onChange={(e) => setImapHost(e.target.value)} className="h-8 text-sm" />
              <Input type="number" placeholder="993" value={imapPort}
                onChange={(e) => setImapPort(Number(e.target.value))} className="h-8 text-sm" />
              <Input placeholder="Username" value={imapUsername}
                onChange={(e) => setImapUsername(e.target.value)} className="h-8 text-sm" />
              <Input type="password" placeholder="App Password" value={imapPassword}
                onChange={(e) => setImapPassword(e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-medium">SMTP (Send)</Label>
              <Input placeholder="smtp.gmail.com" value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)} className="h-8 text-sm" />
              <Input type="number" placeholder="587" value={smtpPort}
                onChange={(e) => setSmtpPort(Number(e.target.value))} className="h-8 text-sm" />
              <Input placeholder="Username" value={smtpUsername}
                onChange={(e) => setSmtpUsername(e.target.value)} className="h-8 text-sm" />
              <Input type="password" placeholder="App Password" value={smtpPassword}
                onChange={(e) => setSmtpPassword(e.target.value)} className="h-8 text-sm" />
            </div>
          </div>

          {!isCreateMode && (
            <div className="flex justify-end">
              <Button type="button" size="sm" className="h-7 text-xs" onClick={handleCreate} disabled={saving}>
                {saving && <Loader2 className="size-3 animate-spin mr-1" />}
                Save & Connect
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
