"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { useWorkspace } from "@/contexts/workspace-context";
import { useAgentContext } from "@/contexts/agent-context";
import { listEmails, getEmailBody, getEmailThread, deleteEmail, sendEmail, listEmailAccounts, updateEmailStatus } from "@/lib/api";
import type { Email, EmailAttachment, AgentEmailAccount } from "@alook/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmailCompose } from "@/components/email-compose";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Loader2, Mail, Inbox, Send, Plus, Trash2, Forward, Reply, Paperclip, File as FileIcon, Copy, Check, ShieldAlert, ChevronDown } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { ResizablePanels } from "@/components/ui/resizable-panels";
import { EmailBodyFrame } from "@/components/email-body-frame";

type Folder = "inbox" | "sent" | "untrust";

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
  const isMobile = useIsMobile();

  const [folder, _setFolder] = useState<Folder>("inbox");
  const [emails, setEmails] = useState<Email[]>([]);
  const unreadCount = useMemo(() => emails.filter(e => e.status === "unread").length, [emails]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [body, setBody] = useState<{ content: string; isHtml: boolean } | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [composing, setComposing] = useState(false);
  const [composeInitial, setComposeInitial] = useState<{
    to?: string; subject?: string; body?: string; attachments?: EmailAttachment[];
    inReplyTo?: string; references?: string;
  }>({});

  const [thread, setThread] = useState<Email[]>([]);
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);
  const [threadBodies, setThreadBodies] = useState<Record<string, { content: string; isHtml: boolean }>>({});

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [emailAccounts, setEmailAccounts] = useState<AgentEmailAccount[]>([]);
  const [mailboxOpen, setMailboxOpen] = useState(false);

  const switchFolder = useCallback((f: Folder) => {
    _setFolder(f);
    setEmails([]);
    setSelectedId(null);
    setBody(null);
    setComposing(false);
  }, []);

  type Mailbox = { type: "alook"; address: string } | { type: "custom"; address: string; accountId: string };
  const alookAddress = agent?.email_handle ? `${agent.email_handle}@alook.ai` : "";
  const mailboxes: Mailbox[] = [
    ...(alookAddress ? [{ type: "alook" as const, address: alookAddress }] : []),
    ...emailAccounts.map((a) => ({ type: "custom" as const, address: a.email_address, accountId: a.id })),
  ];
  const [activeMailboxIdx, setActiveMailboxIdx] = useState(0);
  const activeMailbox = mailboxes[activeMailboxIdx] ?? mailboxes[0] ?? null;
  const activeAddress = activeMailbox?.address ?? "";
  const activeAccountId = activeMailbox?.type === "custom" ? activeMailbox.accountId : undefined;

  const selected = emails.find((e) => e.id === selectedId) ?? null;

  const loadEmails = useCallback(async (dir: string, address?: string) => {
    setLoading(true);
    try {
      const data = await listEmails(agentId, workspaceId, dir, address);
      setEmails(data);
    } catch {
      toast.error("Failed to load emails");
    } finally {
      setLoading(false);
    }
  }, [agentId, workspaceId]);

  useEffect(() => {
    listEmailAccounts(agentId, workspaceId).then(setEmailAccounts).catch(() => {});
  }, [agentId, workspaceId]);

  useEffect(() => {
    loadEmails(folder, activeAddress);
  }, [folder, activeAddress, loadEmails]);

  useEffect(() => {
    return subscribeWs((msg) => {
      if (
        (msg.type === "email.received" && msg.agentId === agentId) ||
        (msg.type === "email.sent" && msg.agentId === agentId)
      ) {
        loadEmails(folder, activeAddress);
      }
    });
  }, [subscribeWs, agentId, folder, activeAddress, loadEmails]);

  const handleSelect = async (emailId: string) => {
    setComposing(false);
    setSelectedId(emailId);
    setBody(null);
    setBodyLoading(true);
    setThread([]);
    setExpandedThreadId(null);
    setThreadBodies({});
    try {
      const [result, threadData] = await Promise.all([
        getEmailBody(emailId, workspaceId),
        getEmailThread(emailId, workspaceId).catch(() => [] as Email[]),
      ]);
      setBody(result);
      setThread(threadData);

      const email = emails.find(e => e.id === emailId);
      if (email && email.status === "unread") {
        updateEmailStatus(emailId, workspaceId, "read")
          .then(() => {
            setEmails(prev => prev.map(e =>
              e.id === emailId ? { ...e, status: "read" } : e
            ));
          })
          .catch(() => {
            setEmails(prev => prev.map(e =>
              e.id === emailId ? { ...e, status: "unread" } : e
            ));
          });
      }
    } catch {
      setBody({ content: "(body not available)", isHtml: false });
    } finally {
      setBodyLoading(false);
    }
  };

  const handleExpandThread = async (emailId: string) => {
    if (expandedThreadId === emailId) {
      setExpandedThreadId(null);
      return;
    }
    setExpandedThreadId(emailId);
    if (!threadBodies[emailId]) {
      try {
        const result = await getEmailBody(emailId, workspaceId);
        setThreadBodies((prev) => ({ ...prev, [emailId]: result }));
      } catch {
        setThreadBodies((prev) => ({ ...prev, [emailId]: { content: "(body not available)", isHtml: false } }));
      }
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

  const handleSend = async (to: string, subject: string, htmlBody: string, attachments: EmailAttachment[], threading?: { inReplyTo?: string; references?: string }): Promise<boolean> => {
    try {
      await sendEmail(agentId, to, subject, htmlBody, workspaceId, attachments.length > 0 ? attachments : undefined, threading, activeAccountId);
      toast.success("Email sent");
      setComposing(false);
      switchFolder("sent");
      return true;
    } catch {
      toast.error("Failed to send email");
      return false;
    }
  };

  const buildQuotedBody = (email: Email) => [
    `<br/><br/>`,
    `<div style="border-left: 2px solid #ccc; padding-left: 12px; margin-left: 0; color: #666;">`,
    `<p><strong>From:</strong> ${email.from_email}<br/>`,
    `<strong>To:</strong> ${email.to_email}<br/>`,
    `<strong>Date:</strong> ${new Date(email.created_at).toLocaleString()}<br/>`,
    `<strong>Subject:</strong> ${email.subject}</p>`,
    email.html_body ? email.html_body : body?.isHtml ? body.content : `<pre>${body?.content ?? ""}</pre>`,
    `</div>`,
  ].join("");

  const buildThreadingContext = (email: Email) => {
    const inReplyTo = email.message_id || undefined;
    const refs = [email.references, email.message_id].filter(Boolean).join(" ").trim() || undefined;
    return { inReplyTo, references: refs };
  };

  const handleReply = (email: Email) => {
    const reSubject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;
    setSelectedId(null);
    setComposeInitial({
      to: email.from_email,
      subject: reSubject,
      body: buildQuotedBody(email),
      ...buildThreadingContext(email),
    });
    setComposing(true);
  };

  const handleForward = (email: Email) => {
    const fwdSubject = email.subject.startsWith("Fwd:") ? email.subject : `Fwd: ${email.subject}`;
    setSelectedId(null);
    setComposeInitial({
      subject: fwdSubject,
      body: buildQuotedBody(email),
      attachments: email.attachments ?? [],
      ...buildThreadingContext(email),
    });
    setComposing(true);
  };

  const [copied, setCopied] = useState(false);

  const handleCopyAddress = async () => {
    if (!activeAddress) return;
    try {
      await navigator.clipboard.writeText(activeAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Failed to copy");
    }
  };

  const sidebarContent = (
    <div className="flex h-full flex-col">
      {mailboxes.length > 0 ? (
        <div className="px-3 pt-3 pb-1 relative">
          {mailboxes.length === 1 ? (
            <button
              type="button"
              onClick={handleCopyAddress}
              className="group flex items-center gap-1.5 text-left cursor-pointer w-full"
              title="Click to copy"
            >
              <span className="text-xs text-muted-foreground truncate">{activeAddress}</span>
              {copied ? (
                <Check className="size-2.5 text-green-500 shrink-0" />
              ) : (
                <Copy className="size-2.5 text-muted-foreground/0 group-hover:text-muted-foreground/60 shrink-0 transition-colors" />
              )}
            </button>
          ) : (
            <>
              <div className="flex items-center gap-1 w-full">
                <button
                  type="button"
                  onClick={() => setMailboxOpen(!mailboxOpen)}
                  className="flex items-center gap-1 text-left cursor-pointer min-w-0 flex-1"
                >
                  <span className="text-xs text-muted-foreground truncate">{activeAddress}</span>
                  <ChevronDown className="size-2.5 text-muted-foreground shrink-0" />
                </button>
                <button
                  type="button"
                  onClick={handleCopyAddress}
                  className="shrink-0 p-0.5"
                  title="Copy address"
                >
                  {copied ? (
                    <Check className="size-2.5 text-green-500" />
                  ) : (
                    <Copy className="size-2.5 text-muted-foreground/40 hover:text-muted-foreground/80 transition-colors" />
                  )}
                </button>
              </div>
              {mailboxOpen && (
                <div className="absolute left-2 right-2 top-full mt-0.5 z-10 rounded-lg border border-border bg-popover shadow-md py-1">
                  {mailboxes.map((mb, i) => (
                    <button
                      key={mb.address}
                      type="button"
                      onClick={() => { setActiveMailboxIdx(i); setMailboxOpen(false); }}
                      className={cn(
                        "flex items-center gap-2 w-full px-2.5 py-1.5 text-left text-xs transition-colors",
                        i === activeMailboxIdx ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                      )}
                    >
                      <Mail className="size-3 shrink-0" />
                      <span className="truncate">{mb.address}</span>
                      {mb.type === "custom" && (
                        <span className="text-[9px] text-muted-foreground/60 shrink-0">IMAP</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="px-3 pt-3 pb-1">
          <p className="text-xs text-muted-foreground/60">No email configured</p>
        </div>
      )}
      <div className="p-2">
        <Button
          size="sm"
          className="w-full justify-start text-xs h-8 gap-1.5"
          onClick={() => { setComposeInitial({}); setComposing(true); setSelectedId(null); }}
          disabled={mailboxes.length === 0}
          title={mailboxes.length === 0 ? "Configure an email in agent settings to send emails" : "Compose new email"}
        >
          <Plus className="size-3.5" />
          New Email
        </Button>
      </div>
      <nav className="flex flex-col gap-0.5 px-2">
        <button
          type="button"
          onClick={() => switchFolder("inbox")}
          className={cn(
            "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors cursor-pointer",
            folder === "inbox"
              ? "bg-accent text-foreground font-medium"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          )}
        >
          <Inbox className="size-4 shrink-0" />
          Inbox
          {folder === "inbox" && unreadCount > 0 && (
            <span className="ml-auto text-xs bg-blue-500 text-white rounded-full px-1.5 py-0.5 leading-none min-w-5 text-center">
              {unreadCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => switchFolder("sent")}
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
        <button
          type="button"
          onClick={() => switchFolder("untrust")}
          className={cn(
            "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors cursor-pointer",
            folder === "untrust"
              ? "bg-accent text-foreground font-medium"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          )}
        >
          <ShieldAlert className="size-4 shrink-0" />
          Untrust
        </button>
      </nav>
    </div>
  );

  const emailListContent = (
    <div className={cn("h-full thin-scrollbar", emails.length > 0 && !loading ? "overflow-y-auto" : "overflow-hidden")}>
      {loading ? (
        <>
          {Array.from({ length: 3 }).map((_, i) => (
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
          <Mail className="size-8 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">
            {folder === "inbox" ? "No emails from trusted senders" : folder === "sent" ? "No emails sent yet" : "No untrusted emails"}
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
              <p className={cn(
                "text-sm truncate",
                email.status === "unread" ? "font-semibold" : "font-medium text-muted-foreground"
              )}>
                {folder === "sent" ? email.to_email : email.from_email}
              </p>
              <div className="flex items-center gap-1.5 shrink-0">
                {folder !== "sent" && (
                  <span className={cn(
                    "text-[10px] rounded-full px-1.5 py-0.5 leading-none font-medium",
                    email.status === "unread"
                      ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                      : "bg-muted text-muted-foreground"
                  )}>
                    {email.status === "unread" ? "unread" : "read"}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {relativeTime(email.created_at)}
                </span>
              </div>
            </div>
            <p className={cn(
              "text-[13px] truncate",
              email.status === "unread" ? "text-foreground" : "text-muted-foreground"
            )}>
              {email.subject || "(no subject)"}
            </p>
          </button>
        ))
      )}
    </div>
  );

  const readingPaneContent = (
    <div className="h-full overflow-auto flex flex-col min-w-0 thin-scrollbar">
      {composing ? (
        <EmailCompose
          key={JSON.stringify(composeInitial)}
          fromAddress={activeAddress}
          onSend={handleSend}
          onDiscard={() => { setComposing(false); setComposeInitial({}); }}
          initialTo={composeInitial.to}
          initialSubject={composeInitial.subject}
          initialBody={composeInitial.body}
          initialAttachments={composeInitial.attachments}
          inReplyTo={composeInitial.inReplyTo}
          references={composeInitial.references}
        />
      ) : !selected ? (
        <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
          Select an email to view
        </div>
      ) : (
        <div className="flex flex-col h-full md:min-w-100 max-w-3xl mx-auto w-full">
          {/* Detail toolbar */}
          <div className="flex items-center gap-0.5 border-b border-border/40 px-4 py-1.5">
            {folder !== "sent" && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground/60 hover:text-foreground"
                title="Reply"
                onClick={() => handleReply(selected)}
              >
                <Reply className="size-3.5" />
              </Button>
            )}
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

          {/* Thread parents */}
          {thread.length > 0 && (
            <div className="border-b border-border/30">
              {thread.map((parent) => (
                <div key={parent.id} className="border-b border-border/20 last:border-b-0">
                  <button
                    type="button"
                    onClick={() => handleExpandThread(parent.id)}
                    className="w-full flex items-center gap-2 px-5 py-2.5 text-left hover:bg-accent/30 transition-colors cursor-pointer"
                  >
                    <span className="text-xs text-muted-foreground">
                      {expandedThreadId === parent.id ? "▾" : "▸"}
                    </span>
                    <span className="text-sm font-medium truncate flex-1">
                      {parent.from_email}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {relativeTime(parent.created_at)}
                    </span>
                  </button>
                  {expandedThreadId === parent.id && (
                    <div className="px-5 pb-3">
                      <p className="text-xs text-muted-foreground mb-2">{parent.subject}</p>
                      {threadBodies[parent.id] ? (
                        threadBodies[parent.id].isHtml ? (
                          <EmailBodyFrame
                            html={threadBodies[parent.id].content}
                            className="max-w-full text-sm"
                          />
                        ) : (
                          <div className="text-sm whitespace-pre-wrap leading-[1.65] text-foreground">
                            {threadBodies[parent.id].content}
                          </div>
                        )
                      ) : (
                        <Loader2 className="size-3 animate-spin text-muted-foreground" />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Email detail */}
          <div className="p-5">
            <h2 className="text-lg font-heading font-semibold tracking-tight mb-1">
              {selected.subject || "(no subject)"}
            </h2>
            <div className="text-sm space-y-1 mb-5">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-16 shrink-0">From</span>
                <span>{selected.from_email}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-16 shrink-0">To</span>
                <span>{selected.to_email}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-16 shrink-0">
                  {folder === "sent" ? "Sent" : "Received"}
                </span>
                <span className="text-muted-foreground">
                  {new Date(selected.created_at).toLocaleString()}
                </span>
              </div>
            </div>

            {bodyLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : selected.html_body ? (
              <EmailBodyFrame
                html={selected.html_body}
                className="max-w-full"
              />
            ) : body?.isHtml ? (
              <EmailBodyFrame
                html={body.content}
                className="max-w-full"
              />
            ) : (
              <div className="text-sm whitespace-pre-wrap leading-[1.65] text-foreground">
                {body?.content}
              </div>
            )}

            {selected.attachments && selected.attachments.length > 0 && (
              <div className="mt-4">
                <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
                  <Paperclip className="size-3" />
                  {selected.attachments.length} attachment{selected.attachments.length > 1 ? "s" : ""}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {selected.attachments.map((att, i) => (
                    <a
                      key={att.key}
                      href={`/api/email/${selected.id}/attachment/${i}?workspace_id=${workspaceId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      download={att.filename}
                      className="flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/50 px-2.5 py-1.5 text-xs hover:bg-muted transition-colors cursor-pointer"
                    >
                      <FileIcon className="size-3 text-muted-foreground shrink-0" />
                      <span className="truncate max-w-45">{att.filename}</span>
                      <span className="text-muted-foreground shrink-0">
                        {att.size < 1024 ? `${att.size} B` : att.size < 1024 * 1024 ? `${(att.size / 1024).toFixed(1)} KB` : `${(att.size / (1024 * 1024)).toFixed(1)} MB`}
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  const mobileContent = (() => {
    if (composing) {
      return (
        <div className="flex flex-col h-full">
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => { setComposing(false); setComposeInitial({}); }}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <span className="text-sm font-medium">New Email</span>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">{readingPaneContent}</div>
        </div>
      );
    }
    if (selectedId && selected) {
      return (
        <div className="flex flex-col h-full">
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => { setSelectedId(null); setBody(null); }}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <span className="text-sm font-medium truncate">{selected.subject || "(no subject)"}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">{readingPaneContent}</div>
        </div>
      );
    }
    return (
      <div className="flex flex-col h-full">
        {mailboxes.length > 1 && (
          <div className="relative px-3 pt-2 pb-1 border-b border-border/30">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setMailboxOpen(!mailboxOpen)}
                className="flex items-center gap-1 text-left cursor-pointer min-w-0 flex-1"
              >
                <span className="text-xs text-muted-foreground truncate">{activeAddress}</span>
                <ChevronDown className="size-2.5 text-muted-foreground shrink-0" />
              </button>
              <button
                type="button"
                onClick={handleCopyAddress}
                className="shrink-0 p-0.5"
                title="Copy address"
              >
                {copied ? (
                  <Check className="size-2.5 text-green-500" />
                ) : (
                  <Copy className="size-2.5 text-muted-foreground/40 hover:text-muted-foreground/80 transition-colors" />
                )}
              </button>
            </div>
            {mailboxOpen && (
              <div className="absolute left-2 right-2 top-full mt-0.5 z-10 rounded-lg border border-border bg-popover shadow-md py-1">
                {mailboxes.map((mb, i) => (
                  <button
                    key={mb.address}
                    type="button"
                    onClick={() => { setActiveMailboxIdx(i); setMailboxOpen(false); }}
                    className={cn(
                      "flex items-center gap-2 w-full px-2.5 py-1.5 text-left text-xs transition-colors",
                      i === activeMailboxIdx ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                    )}
                  >
                    <Mail className="size-3 shrink-0" />
                    <span className="truncate">{mb.address}</span>
                    {mb.type === "custom" && (
                      <span className="text-[9px] text-muted-foreground/60 shrink-0">IMAP</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-1 border-b border-border/50 px-3 py-2">
          <div className="flex items-center gap-0.5 flex-1 min-w-0">
            {([
              { id: "inbox" as Folder, label: "Inbox" },
              { id: "sent" as Folder, label: "Sent" },
              { id: "untrust" as Folder, label: "Untrust" },
            ]).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => switchFolder(f.id)}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                  folder === f.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {f.label}
                {f.id === "inbox" && folder === "inbox" && unreadCount > 0 && (
                  <span className="ml-0.5 text-[10px] bg-blue-500 text-white rounded-full px-1 leading-none min-w-4 text-center">
                    {unreadCount}
                  </span>
                )}
              </button>
            ))}
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => { setComposeInitial({}); setComposing(true); setSelectedId(null); }}
            disabled={mailboxes.length === 0}
          >
            <Plus className="size-4" />
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">{emailListContent}</div>
      </div>
    );
  })();

  return (
    <>
      {isMobile ? (
        mobileContent
      ) : (
        <ResizablePanels
          storageKey="email-panel-sizes"
          panels={[
            { defaultWidth: 180, minWidth: 120, maxWidth: 240, children: sidebarContent },
            { defaultWidth: 300, minWidth: 200, maxWidth: 480, children: emailListContent },
            { children: readingPaneContent, minWidth: 300 },
          ]}
        />
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete email"
        description="This will permanently delete this email."
        loading={deleting}
        onConfirm={handleDelete}
      />
    </>
  );
}
