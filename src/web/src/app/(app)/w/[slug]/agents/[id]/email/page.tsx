"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { FileDownloadButton } from "@/components/file-download-button"
import { useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation, type Query } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useWorkspaceOwner, captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions, runWorkspaceRequest } from "@/contexts/workspace-context";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { emailListOptions, emailThreadOptions, emailBodyOptions, emailEntityKey, useEmailRows } from "@/hooks/workspace/email-query-options";
import { isAbortError } from "@/lib/errors";
import { useAgentContext } from "@/contexts/agent-context";
import { deleteEmail, sendEmail, listEmailAccounts, updateEmailStatus, trustEmail } from "@/lib/api";
import { toAlookAddress } from "@alook/shared";
import type { Email, EmailAttachment } from "@alook/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmailCompose } from "@/components/email-compose";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Loader2, Mail, Inbox, Send, Plus, Trash2, Forward, Reply, Paperclip, File as FileIcon, Copy, Check, ShieldAlert, ShieldCheck, ChevronDown } from "lucide-react";
import { trackEmailComposed, trackEmailReceived } from "@/lib/analytics";
import { useIsMobile } from "@/hooks/use-mobile";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
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
  return <AgentEmailSurface key={params.id as string} agentId={params.id as string} />;
}

function AgentEmailSurface({ agentId }: { agentId: string }) {
  const owner = useWorkspaceOwner();
  const { workspaceId } = owner;
  const { agents, subscribeWs } = useAgentContext();
  const agent = agents.find((row) => row.id === agentId);
  const isMobile = useIsMobile();
  const [folder, _setFolder] = useAtom(useCreateAtom<Folder>("inbox"));
  const [selectedId, setSelectedId] = useAtom(useCreateAtom<string | null>(null));
  const [composing, setComposing] = useAtom(useCreateAtom(false));
  const [composeInitial, setComposeInitial] = useAtom(useCreateAtom<{
    to?: string; subject?: string; body?: string; attachments?: EmailAttachment[];
    inReplyTo?: string; references?: string;
  }>({}));
  const [expandedThreadId, setExpandedThreadId] = useAtom(useCreateAtom<string | null>(null));
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useAtom(useCreateAtom(false));
  const [deleteTarget, setDeleteTarget] = useAtom(useCreateAtom<string | null>(null));
  const [mailboxOpen, setMailboxOpen] = useAtom(useCreateAtom(false));
  const accountsQuery = useQuery({ queryKey: owner.key("email-accounts", agentId), queryFn: ({ signal }) => runWorkspaceRequest(owner, (options) => listEmailAccounts(agentId, workspaceId, options), signal) });
  const emailAccounts = accountsQuery.data ?? [];
  type Mailbox = { type: "alook"; address: string } | { type: "custom"; address: string; accountId: string };
  const alookAddress = agent?.email_handle ? toAlookAddress(agent.email_handle) : "";
  const mailboxes: Mailbox[] = [
    ...(alookAddress ? [{ type: "alook" as const, address: alookAddress }] : []),
    ...emailAccounts.map((row) => ({ type: "custom" as const, address: row.email_address, accountId: row.id })),
  ];
  const [activeMailboxIdx, setActiveMailboxIdx] = useAtom(useCreateAtom(0));
  const activeMailbox = mailboxes[activeMailboxIdx] ?? mailboxes[0] ?? null;
  const activeAddress = activeMailbox?.address ?? "";
  const activeAccountId = activeMailbox?.type === "custom" ? activeMailbox.accountId : undefined;
  const source = useWorkspaceViewSource(owner, JSON.stringify(["email", agentId, folder, activeAddress, selectedId, composing, deleteConfirmOpen, deleteTarget]), true);
  const list = useQuery(emailListOptions(owner, agentId, folder, activeAddress));
  const emails = useEmailRows(owner, list.data?.ids ?? []);
  const unreadCount = useMemo(() => emails.filter((email) => email.status === "unread").length, [emails]);
  const selected = emails.find((email) => email.id === selectedId) ?? null;
  const bodyQuery = useQuery({ ...emailBodyOptions(owner, selectedId ?? ""), enabled: !!selectedId, subscribed: !!selectedId });
  const threadQuery = useQuery({ ...emailThreadOptions(owner, selectedId ?? ""), enabled: !!selectedId, subscribed: !!selectedId });
  const thread = useEmailRows(owner, threadQuery.data?.ids ?? []);
  const expandedBody = useQuery({ ...emailBodyOptions(owner, expandedThreadId ?? ""), enabled: !!expandedThreadId, subscribed: !!expandedThreadId });
  const body = bodyQuery.data ?? (bodyQuery.isError ? { content: "(body not available)", isHtml: false } : null);
  const threadBodies = expandedThreadId && expandedBody.data ? { [expandedThreadId]: expandedBody.data } : {};
  const loading = list.isPending;
  const bodyLoading = !!selectedId && bodyQuery.isPending;
  const switchFolder = useCallback((next: Folder) => {
    _setFolder(next);
    setSelectedId(null);
    setExpandedThreadId(null);
    setComposing(false);
  }, [_setFolder, setSelectedId, setExpandedThreadId, setComposing]);
  const commandKey = owner.key("email-command", agentId);
  type Action = { kind: "delete" | "read" | "trust"; id: string } | {
    kind: "send"; to: string; subject: string; htmlBody: string; attachments: EmailAttachment[];
    threading?: { inReplyTo?: string; references?: string }; accountId?: string;
  };
  type Input = { action: Action; token: ReturnType<typeof captureWorkspaceOwner> };
  type Intent = Input & { view: ReturnType<typeof source.capture>; resources: Query[] };
  const native = useMutation({ gcTime: 0, mutationKey: commandKey, scope: { id: JSON.stringify(commandKey) },
    mutationFn: async ({ action, token, view, resources }: Intent) => {
      const assert = () => { assertWorkspaceOwner(token, view.signal); view.assert(); };
      assert();
      const allowed = (query: Query) => resources.includes(query);
      await owner.queryClient.cancelQueries({ queryKey: owner.key("email", "windows"), predicate: allowed });
      assert();
      const options = workspaceRequestOptions(token, view.signal, assert);
      const entityKey = action.kind === "send" ? null : emailEntityKey(owner, action.id);
      const entity = entityKey ? resources.find((query) => JSON.stringify(query.queryKey) === JSON.stringify(entityKey)) : undefined;
      const baseline = entity?.state.data as Email | null | undefined;
      const writes = entity?.state.dataUpdateCount;
      const originalEntity = () => entity && owner.queryClient.getQueryCache().find({ queryKey: entity.queryKey, exact: true }) === entity && entity.state.dataUpdateCount === writes;
      try {
        if (action.kind === "delete") {
          await deleteEmail(action.id, workspaceId, options);
          assert();
          if (originalEntity() && entity!.state.data === baseline) owner.queryClient.setQueryData<Email | null>(emailEntityKey(owner, action.id), null);
          owner.queryClient.removeQueries({ queryKey: emailBodyOptions(owner, action.id).queryKey, exact: true, predicate: allowed });
        } else if (action.kind === "read") {
          const before = baseline;
          const confirmed = await updateEmailStatus(action.id, workspaceId, "read", options);
          assert();
          if (originalEntity()) owner.queryClient.setQueryData<Email | null>(emailEntityKey(owner, action.id), (current) => current && current.status === before?.status ? { ...current, status: confirmed.status } : current);
        } else if (action.kind === "trust") {
          const result = await trustEmail(action.id, workspaceId, options);
          assert();
          if (originalEntity()) owner.queryClient.setQueryData<Email | null>(emailEntityKey(owner, action.id), (current) => current ? { ...current, ...Object.fromEntries(Object.entries(result.email).filter(([key]) => key !== "html_body" && current[key as keyof Email] === baseline?.[key as keyof Email])) } : current);
        } else if (action.kind === "send") {
          const result = await sendEmail(agentId, action.to, action.subject, action.htmlBody, workspaceId, action.attachments.length ? action.attachments : undefined, action.threading, action.accountId, options);
          assert();
          const canonical: Email = { ...result, html_body: "" };
          if (!owner.queryClient.getQueryData<Email | null>(emailEntityKey(owner, result.id))) owner.queryClient.setQueryData<Email | null>(emailEntityKey(owner, result.id), canonical);
        }
        assert();
        await owner.queryClient.invalidateQueries({ queryKey: owner.key("email", "windows"), predicate: allowed }, { cancelRefetch: false });
        assert();
      } catch (error) { assert(); throw error; }
    },
  });
  const capture = (input: Input): Intent => { const view = source.capture(); view.assert(); assertWorkspaceOwner(input.token, view.signal); return { ...input, view, resources: owner.queryClient.getQueryCache().findAll({ queryKey: owner.key("email") }) }; };
  const command = { ...native, mutate: (input: Input) => native.mutate(capture(input)), mutateAsync: (input: Input) => native.mutateAsync(capture(input)) };
  const deleting = command.isPending && command.variables?.action.kind === "delete";
  const trusting = command.isPending && command.variables?.action.kind === "trust";
  useEffect(() => {
    if (!list.error || isAbortError(list.error)) return;
    try { source.assertActive(); } catch { return; }
    toast.error("Failed to load emails");
  }, [list.error, source, source.assertActive]);
  useEffect(() => subscribeWs((message) => {
    if ((message.type !== "email.received" && message.type !== "email.sent") || message.agentId !== agentId) return;
    const token = captureWorkspaceOwner(owner);
    try { assertWorkspaceOwner(token); } catch { return; }
    if (message.type === "email.received") trackEmailReceived({ agent_id: agentId, mailbox_type: activeMailbox?.type === "custom" ? "imap" : "alook" });
    void owner.queryClient.cancelQueries({ queryKey: owner.key("email", "windows") }).then(() => {
      assertWorkspaceOwner(token);
      return owner.queryClient.invalidateQueries({ queryKey: owner.key("email", "windows") });
    }).catch(() => undefined);
  }), [owner, subscribeWs, agentId, activeMailbox?.type]);
  const mutateEmail = command.mutate;
  useEffect(() => {
    if (!selected || selected.status !== "unread" || !bodyQuery.data) return;
    mutateEmail({ action: { kind: "read", id: selected.id }, token: captureWorkspaceOwner(owner) });
  }, [selected, bodyQuery.data, owner, mutateEmail]);
  const handleSelect = (id: string) => { setComposing(false); setSelectedId(id); setExpandedThreadId(null); };
  const handleExpandThread = (id: string) => setExpandedThreadId((current) => current === id ? null : id);
  const handleDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget, assertView = source.capture().assert;
    assertView();
    try {
      await command.mutateAsync({ action: { kind: "delete", id }, token: captureWorkspaceOwner(owner) });
      assertView();
      if (selectedId === id) setSelectedId(null);
      toast.success("Email deleted");
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error("Failed to delete email");
    } finally {
      try { assertView(); setDeleteConfirmOpen(false); setDeleteTarget(null); } catch {}
    }
  };
  const handleSend = async (to: string, subject: string, htmlBody: string, attachments: EmailAttachment[], threading?: { inReplyTo?: string; references?: string }): Promise<boolean> => {
    if (owner.queryClient.isMutating({ mutationKey: commandKey, exact: true, predicate: (mutation) => (mutation.state.variables as Intent).action.kind === "send" })) return false;
    const assertView = source.capture().assert;
    assertView();
    try {
      await command.mutateAsync({ action: { kind: "send", to, subject, htmlBody, attachments, threading, accountId: activeAccountId }, token: captureWorkspaceOwner(owner) });
      assertView();
      trackEmailComposed({ agent_id: agentId, has_attachments: attachments.length > 0 });
      toast.success("Email sent");
      switchFolder("sent");
      return true;
    } catch (error) {
      try { assertView(); } catch { return false; }
      if (!isAbortError(error)) toast.error("Failed to send email");
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

  const handleTrust = async (email: Email) => {
    const assertView = source.capture().assert;
    assertView();
    try {
      await command.mutateAsync({ action: { kind: "trust", id: email.id }, token: captureWorkspaceOwner(owner) });
      assertView();
      toast.success("Email trusted and sent to agent");
      setSelectedId(null);
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error("Failed to trust email");
    }
  };


  const [copied, setCopied] = useAtom(useCreateAtom(false));

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
            <Tooltip>
              <TooltipTrigger render={<button
                type="button"
                onClick={handleCopyAddress}
                className="group flex items-center gap-2 text-left cursor-pointer w-full"
              />}>
                <span className="text-xs text-muted-foreground truncate">{activeAddress}</span>
                {copied ? (
                  <Check className="size-2.5 text-green-500 shrink-0" />
                ) : (
                  <Copy className="size-2.5 text-muted-foreground/0 group-hover:text-muted-foreground/60 shrink-0 transition-colors" />
                )}
              </TooltipTrigger>
              <TooltipContent>Click to copy</TooltipContent>
            </Tooltip>
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
                <Tooltip>
                  <TooltipTrigger render={<button
                    type="button"
                    onClick={handleCopyAddress}
                    className="shrink-0 p-1"
                  />}>
                    {copied ? (
                      <Check className="size-2.5 text-green-500" />
                    ) : (
                      <Copy className="size-2.5 text-muted-foreground/40 hover:text-muted-foreground/80 transition-colors" />
                    )}
                  </TooltipTrigger>
                  <TooltipContent>Copy address</TooltipContent>
                </Tooltip>
              </div>
              {mailboxOpen && (
                <div className="absolute left-2 right-2 top-full mt-1 z-10 rounded-lg border border-border bg-popover shadow-md py-1">
                  {mailboxes.map((mb, i) => (
                    <button
                      key={mb.address}
                      type="button"
                      onClick={() => { setActiveMailboxIdx(i); setMailboxOpen(false); }}
                      className={cn(
                        "flex items-center gap-2 w-full px-2 py-2 text-left text-xs transition-colors",
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
        <Tooltip>
          <TooltipTrigger render={<Button
            size="sm"
            className="w-full justify-start text-xs h-8 gap-2"
            onClick={() => { setComposeInitial({}); setComposing(true); setSelectedId(null); }}
            disabled={mailboxes.length === 0}
          />}>
            <Plus className="size-3.5" />
            New Email
          </TooltipTrigger>
          <TooltipContent>{mailboxes.length === 0 ? "Configure an email in agent settings to send emails" : "Compose new email"}</TooltipContent>
        </Tooltip>
      </div>
      <nav className="flex flex-col gap-1 px-2">
        <button
          type="button"
          onClick={() => switchFolder("inbox")}
          className={cn(
            "flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors cursor-pointer",
            folder === "inbox"
              ? "bg-accent text-foreground font-medium"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          )}
        >
          <Inbox className="size-4 shrink-0" />
          Inbox
          {folder === "inbox" && unreadCount > 0 && (
            <span className="ml-auto text-xs bg-blue-500 text-white rounded-full px-2 py-1 leading-none min-w-5 text-center">
              {unreadCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => switchFolder("sent")}
          className={cn(
            "flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors cursor-pointer",
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
            "flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors cursor-pointer",
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
              <div className="flex items-center justify-between gap-2 mb-2">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-2.5 w-10" />
              </div>
              <Skeleton className="h-3.5 w-48 mb-2" />
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
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className={cn(
                "text-sm truncate",
                email.status === "unread" ? "font-semibold" : "font-medium text-muted-foreground"
              )}>
                {folder === "sent" ? email.to_email : email.from_email}
              </p>
              <div className="flex items-center gap-2 shrink-0">
                {folder === "sent" && email.status === "blocked" && (
                  <Tooltip>
                    <TooltipTrigger render={<span className="inline-flex items-center gap-1 text-[10px] rounded-full px-2 py-1 leading-none font-medium bg-destructive/10 text-destructive" />}>
                      <ShieldAlert className="size-3" />
                      Blocked
                    </TooltipTrigger>
                    <TooltipContent>Blocked — not sent</TooltipContent>
                  </Tooltip>
                )}
                {folder !== "sent" && (
                  <span className={cn(
                    "text-[10px] rounded-full px-2 py-1 leading-none font-medium",
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
        <div className="flex flex-col h-full sm:min-w-100 max-w-3xl mx-auto w-full">
          {/* Detail toolbar */}
          <div className="flex items-center gap-1 border-b border-border/40 px-4 py-2">
            {folder === "untrust" && (
              <Tooltip>
                <TooltipTrigger render={<Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground/60 hover:text-foreground"
                  disabled={trusting}
                  onClick={() => handleTrust(selected)}
                />}>
                  {trusting ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                </TooltipTrigger>
                <TooltipContent>Trust this email</TooltipContent>
              </Tooltip>
            )}
            {folder !== "sent" && (
              <Tooltip>
                <TooltipTrigger render={<Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground/60 hover:text-foreground"
                  onClick={() => handleReply(selected)}
                />}>
                  <Reply className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>Reply</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger render={<Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground/60 hover:text-foreground"
                onClick={() => handleForward(selected)}
              />}>
                <Forward className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Forward</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={<Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground/60 hover:text-destructive"
                onClick={() => {
                  setDeleteTarget(selected.id);
                  setDeleteConfirmOpen(true);
                }}
              />}>
                <Trash2 className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
          </div>

          {/* Thread parents */}
          {thread.length > 0 && (
            <div className="border-b border-border/30">
              {thread.map((parent) => (
                <div key={parent.id} className="border-b border-border/20 last:border-b-0">
                  <button
                    type="button"
                    onClick={() => handleExpandThread(parent.id)}
                    className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-accent/30 transition-colors cursor-pointer"
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
                    <div className="px-4 pb-3">
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
          <div className="p-4">
            <h2 className="text-lg font-heading font-semibold tracking-tight mb-1">
              {selected.subject || "(no subject)"}
            </h2>
            <div className="text-sm space-y-1 mb-4">
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
                <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
                  <Paperclip className="size-3" />
                  {selected.attachments.length} attachment{selected.attachments.length > 1 ? "s" : ""}
                </div>
                <div className="flex flex-wrap gap-2">
                  {selected.attachments.map((att, i) => (
                    <FileDownloadButton
                      key={att.key}
                      url={`/api/email/${selected.id}/attachment/${i}?workspace_id=${workspaceId}`}
                      filename={att.filename}
                      className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/50 px-2 py-2 text-xs hover:bg-muted transition-colors cursor-pointer"
                    >
                      <FileIcon className="size-3 text-muted-foreground shrink-0" />
                      <span className="truncate max-w-45">{att.filename}</span>
                      <span className="text-muted-foreground shrink-0">
                        {att.size < 1024 ? `${att.size} B` : att.size < 1024 * 1024 ? `${(att.size / 1024).toFixed(1)} KB` : `${(att.size / (1024 * 1024)).toFixed(1)} MB`}
                      </span>
                    </FileDownloadButton>
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
              onClick={() => setSelectedId(null)}
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
              <Tooltip>
                <TooltipTrigger render={<button
                  type="button"
                  onClick={handleCopyAddress}
                  className="shrink-0 p-1"
                />}>
                  {copied ? (
                    <Check className="size-2.5 text-green-500" />
                  ) : (
                    <Copy className="size-2.5 text-muted-foreground/40 hover:text-muted-foreground/80 transition-colors" />
                  )}
                </TooltipTrigger>
                <TooltipContent>Copy address</TooltipContent>
              </Tooltip>
            </div>
            {mailboxOpen && (
              <div className="absolute left-2 right-2 top-full mt-1 z-10 rounded-lg border border-border bg-popover shadow-md py-1">
                {mailboxes.map((mb, i) => (
                  <button
                    key={mb.address}
                    type="button"
                    onClick={() => { setActiveMailboxIdx(i); setMailboxOpen(false); }}
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-2 text-left text-xs transition-colors",
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
          <div className="flex items-center gap-1 flex-1 min-w-0">
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
                  "px-2 py-1 rounded-md text-xs font-medium transition-colors",
                  folder === f.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {f.label}
                {f.id === "inbox" && folder === "inbox" && unreadCount > 0 && (
                  <span className="ml-1 text-[10px] bg-blue-500 text-white rounded-full px-1 leading-none min-w-4 text-center">
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
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="15%" minSize="10%" maxSize="20%">
            {sidebarContent}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="30%" minSize="15%" maxSize="40%">
            {emailListContent}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="55%" minSize="25%">
            {readingPaneContent}
          </ResizablePanel>
        </ResizablePanelGroup>
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
