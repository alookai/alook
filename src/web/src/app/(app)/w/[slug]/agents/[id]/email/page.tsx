"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useWorkspace } from "@/contexts/workspace-context";
import { useAgentContext } from "@/contexts/agent-context";
import { listEmails, getEmailBody, deleteEmail, sendEmail } from "@/lib/api";
import type { Email, EmailAttachment } from "@alook/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmailCompose } from "@/components/email-compose";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Mail, Inbox, Send, Plus, Trash2, Forward, Paperclip, File as FileIcon } from "lucide-react";

type Folder = "inbox" | "sent";

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function AgentEmailPage() {
  const params = useParams();
  const agentId = params.id as string;
  const { workspaceId } = useWorkspace();
  const { agents, subscribeWs } = useAgentContext();

  const agent = agents.find((a) => a.id === agentId);

  const [folder, setFolder] = useState<Folder>("inbox");
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [composing, setComposing] = useState(false);
  const [composeInitial, setComposeInitial] = useState<{
    to?: string; subject?: string; body?: string; attachments?: EmailAttachment[];
  }>({});

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const selected = emails.find((e) => e.id === selectedId) ?? null;

  const loadEmails = useCallback(async (dir: string) => {
    setLoading(true);
    try {
      const data = await listEmails(agentId, workspaceId, dir);
      setEmails(data);
    } catch {
      toast.error("Failed to load emails");
    } finally {
      setLoading(false);
    }
  }, [agentId, workspaceId]);

  useEffect(() => {
    setSelectedId(null);
    setBody(null);
    setComposing(false);
    loadEmails(folder);
  }, [folder, loadEmails]);

  useEffect(() => {
    return subscribeWs((msg) => {
      if (msg.type === "email.received" && msg.agentId === agentId) {
        loadEmails(folder);
      }
    });
  }, [subscribeWs, agentId, folder, loadEmails]);

  const handleSelect = async (emailId: string) => {
    setComposing(false);
    setSelectedId(emailId);
    setBody(null);
    setBodyLoading(true);
    try {
      const text = await getEmailBody(emailId, workspaceId);
      setBody(text);
    } catch {
      setBody("(body not available)");
    } finally {
      setBodyLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteEmail(deleteTarget, workspaceId);
      setEmails((prev) => prev.filter((e) => e.id !== deleteTarget));
      if (selectedId === deleteTarget) {
        setSelectedId(null);
        setBody(null);
      }
      toast.success("Email deleted");
    } catch {
      toast.error("Failed to delete email");
    } finally {
      setDeleting(false);
      setDeleteConfirmOpen(false);
      setDeleteTarget(null);
    }
  };

  const handleSend = async (to: string, subject: string, htmlBody: string, attachments: EmailAttachment[]): Promise<boolean> => {
    try {
      await sendEmail(agentId, to, subject, htmlBody, workspaceId, attachments.length > 0 ? attachments : undefined);
      toast.success("Email sent");
      setComposing(false);
      setFolder("sent");
      return true;
    } catch {
      toast.error("Failed to send email");
      return false;
    }
  };

  const handleForward = (email: Email) => {
    const fwdSubject = email.subject.startsWith("Fwd:") ? email.subject : `Fwd: ${email.subject}`;
    const quotedBody = [
      `<br/><br/>`,
      `<div style="border-left: 2px solid #ccc; padding-left: 12px; margin-left: 0; color: #666;">`,
      `<p><strong>From:</strong> ${email.from_email}<br/>`,
      `<strong>To:</strong> ${email.to_email}<br/>`,
      `<strong>Date:</strong> ${new Date(email.created_at).toLocaleString()}<br/>`,
      `<strong>Subject:</strong> ${email.subject}</p>`,
      email.html_body ? email.html_body : `<pre>${body ?? ""}</pre>`,
      `</div>`,
    ].join("");

    setSelectedId(null);
    setComposeInitial({
      subject: fwdSubject,
      body: quotedBody,
      attachments: email.attachments ?? [],
    });
    setComposing(true);
  };

  const fromAddress = agent?.email_handle ? `${agent.email_handle}@alook.ai` : "";

  return (
    <div className="flex flex-1 min-h-0">
      {/* Column 1: Folder sidebar */}
      <div className="flex w-[180px] shrink-0 flex-col border-r border-border/40">
        <div className="p-2">
          <Button
            size="sm"
            className="w-full text-xs h-8 gap-1.5"
            onClick={() => { setComposeInitial({}); setComposing(true); setSelectedId(null); }}
            disabled={!agent?.email_handle}
            title={!agent?.email_handle ? "Configure an email handle in agent settings to send emails" : "Compose new email"}
          >
            <Plus className="size-3.5" />
            New Email
          </Button>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          <button
            type="button"
            onClick={() => setFolder("inbox")}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors cursor-pointer",
              folder === "inbox"
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            <Inbox className="size-4 shrink-0" />
            Inbox
          </button>
          <button
            type="button"
            onClick={() => setFolder("sent")}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors cursor-pointer",
              folder === "sent"
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            <Send className="size-4 shrink-0" />
            Sent
          </button>
        </nav>
      </div>

      {/* Column 2: Email list */}
      <div className="w-[300px] shrink-0 border-r border-border/40 overflow-y-auto">
        {loading ? (
          <>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="px-4 py-3 border-b border-border/30">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-2.5 w-10" />
                </div>
                <Skeleton className="h-3.5 w-48 mb-1.5" />
                <Skeleton className="h-4 w-16 rounded-full" />
              </div>
            ))}
          </>
        ) : emails.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full animate-[fade-up_400ms_ease-out_both]">
            <Mail className="size-8 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">
              {folder === "inbox" ? "No emails received yet." : "No emails sent yet."}
            </p>
          </div>
        ) : (
          emails.map((email) => (
            <button
              key={email.id}
              type="button"
              onClick={() => handleSelect(email.id)}
              className={cn(
                "w-full text-left px-4 py-3 border-b border-border/30 transition-colors duration-150 cursor-pointer",
                selectedId === email.id
                  ? "bg-accent/60"
                  : "hover:bg-accent/30"
              )}
            >
              <div className="flex items-center justify-between gap-2 mb-0.5">
                <p className="text-sm font-medium truncate">
                  {folder === "inbox" ? email.from_email : email.to_email}
                </p>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {relativeTime(email.created_at)}
                </span>
              </div>
              <p className="text-sm truncate text-muted-foreground">
                {email.subject || "(no subject)"}
              </p>
              {folder === "inbox" && (
                <div className="mt-1">
                  {email.is_whitelisted ? (
                    <Badge className="text-[10px] h-4 px-1">triggered</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px] h-4 px-1">
                      forwarded
                    </Badge>
                  )}
                </div>
              )}
            </button>
          ))
        )}
      </div>

      {/* Column 3: Reading pane */}
      <div className="flex-1 overflow-y-auto flex flex-col min-w-0">
        {composing ? (
          <EmailCompose
            key={JSON.stringify(composeInitial)}
            fromAddress={fromAddress}
            onSend={handleSend}
            onDiscard={() => { setComposing(false); setComposeInitial({}); }}
            initialTo={composeInitial.to}
            initialSubject={composeInitial.subject}
            initialBody={composeInitial.body}
            initialAttachments={composeInitial.attachments}
          />
        ) : !selected ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select an email to view
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Detail toolbar */}
            <div className="flex items-center gap-0.5 border-b border-border/40 px-4 py-1.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground/60 hover:text-foreground"
                title="Forward"
                onClick={() => handleForward(selected)}
              >
                <Forward className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground/60 hover:text-destructive"
                title="Delete"
                onClick={() => {
                  setDeleteTarget(selected.id);
                  setDeleteConfirmOpen(true);
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>

            {/* Email detail */}
            <div className="p-5 max-w-2xl">
              <h2 className="text-lg font-medium mb-1">
                {selected.subject || "(no subject)"}
              </h2>
              {folder === "inbox" && (
                <div className="flex items-center gap-2 mb-4">
                  {selected.is_whitelisted ? (
                    <Badge className="text-[10px] h-4 px-1">triggered</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px] h-4 px-1">
                      forwarded
                    </Badge>
                  )}
                </div>
              )}
              <div className="text-sm text-muted-foreground space-y-0.5 mb-5">
                <p>
                  <span className="font-medium text-foreground">From:</span>{" "}
                  {selected.from_email}
                </p>
                <p>
                  <span className="font-medium text-foreground">To:</span>{" "}
                  {selected.to_email}
                </p>
                <p>
                  <span className="font-medium text-foreground">
                    {folder === "inbox" ? "Received:" : "Sent:"}
                  </span>{" "}
                  {new Date(selected.created_at).toLocaleString()}
                </p>
              </div>

              <div className="rounded-lg border border-border/50 bg-background/50 p-4">
                {bodyLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  </div>
                ) : selected.from_email === fromAddress && selected.html_body ? (
                  <div
                    className="prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: selected.html_body }}
                  />
                ) : (
                  <pre className="text-sm whitespace-pre-wrap font-mono leading-relaxed">
                    {body}
                  </pre>
                )}
              </div>

              {selected.attachments && selected.attachments.length > 0 && (
                <div className="mt-4">
                  <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
                    <Paperclip className="size-3" />
                    {selected.attachments.length} attachment{selected.attachments.length > 1 ? "s" : ""}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {selected.attachments.map((att) => (
                      <div
                        key={att.key}
                        className="flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/50 px-2.5 py-1.5 text-xs"
                      >
                        <FileIcon className="size-3 text-muted-foreground shrink-0" />
                        <span className="truncate max-w-[180px]">{att.filename}</span>
                        <span className="text-muted-foreground shrink-0">
                          {att.size < 1024 ? `${att.size} B` : att.size < 1024 * 1024 ? `${(att.size / 1024).toFixed(1)} KB` : `${(att.size / (1024 * 1024)).toFixed(1)} MB`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete email"
        description="This will permanently delete this email."
        loading={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}
