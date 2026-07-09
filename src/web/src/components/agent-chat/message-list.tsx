import React, { memo } from "react";
import { parseEmailHandle, type Agent, type Artifact, type Message, type TaskApi as Task, type TaskMessageResponse } from "@alook/shared";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Streamdown } from "streamdown";
import { mermaid, cjk, math } from "@/lib/streamdown-plugins";
import { highlightMentions } from "@/lib/highlight-mentions";
import { TaskStream } from "@/components/task-stream";
import { RuntimeErrorBlock } from "@/components/agent-chat/runtime-error-block";
import { AnimatedAvatar, type AvatarConfig } from "@/components/avatar";
import { FileText, Flag, Copy, Check, MessageSquareQuote, MessageSquare, Image as ImageIcon } from "lucide-react";
import { getArtifactThumbnailUrl } from "@/components/artifact-content-renderer";
import type { PendingFile } from "@/hooks/use-file-attachments";
import { EmailCard } from "@/components/agent-chat/event-cards/email-card";
import { CalendarCard } from "@/components/agent-chat/event-cards/calendar-card";
import { IssueCard } from "@/components/agent-chat/event-cards/issue-card";
import { MessageBubble, MessageCluster, AVATAR_SIZE, type BubblePosition } from "@/components/chat-primitives";

import { eventTypeFromMessage, type GroupPosition } from "@/components/agent-chat/chat-message-utils";
import { toast } from "sonner";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useHoverCapable } from "@/hooks/use-hover-capable";
import { useLongPress } from "@/hooks/use-long-press";

const MENTION_ALLOWED_TAGS = { mention: ["data-agent-id"] };
const MENTION_LITERAL_TAGS = ["mention"];

function toBubblePosition(gp: GroupPosition): BubblePosition {
  return gp === "solo" ? "single" : gp;
}

/**
 * Whether an assistant message renders its own body (text bubble or, for a
 * runtime-error message, its RuntimeErrorBlock) — independent of the live error
 * stream wrapper, which is ADDITIVE.
 *
 * The AC4 fix: a normal `send-dm` text reply must paint even when it's the
 * message designated to carry the live error stream (`hasTaskStream`), so its
 * text is never swallowed. The one exception is a runtime-error message: it IS
 * the error and is already surfaced by the stream while live, so it only renders
 * its own block when no stream owns it (`!hasTaskStream`) — avoiding a double
 * error render.
 */
export function shouldRenderAssistantBody(opts: {
  hasTaskStream: boolean;
  isRuntimeError: boolean;
}): boolean {
  return !opts.hasTaskStream || !opts.isRuntimeError;
}

export interface MessageItemProps {
  msg: Message;
  agents: Agent[];
  artifacts: Artifact[];
  activeTask: Task | null;
  /**
   * Id of the single assistant message for the active task that should carry the
   * live error-surface (TaskStream). When a task emits multiple `send-dm`
   * replies, only this one (the last) gets the stream wrapper — the rest fall to
   * the clean bubble path. Null when there's no active-task assistant message.
   */
  activeTaskStreamMsgId?: string | null;
  taskMessages: TaskMessageResponse[];
  connectionLost: boolean;
  conversationType?: string | null;
  pendingFilesByMessage: Map<string, PendingFile[]>;
  workspaceId: string;
  onArtifactClick: (a: Artifact) => void;
  onEmailClick: (emailId: string) => void;
  onIssueClick: (issueId: string) => void;
  onCalendarEventClick: (calendarEventId: string) => void;
  onRetry?: () => void;
  mentionComponents: Record<string, React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>>;
  isFlagged?: boolean;
  onToggleFlag?: (messageId: string) => void;
  groupPosition?: GroupPosition;
  /** Provider of the conversation's agent runtime, used to attribute runtime errors (issue #236). */
  provider?: string | null;
  /** Agent display name + avatar, for the agent-side IM bubbles and system cards. */
  agentName: string;
  agentAvatarConfig: AvatarConfig | null;
  /** This optimistic user message failed to send — show the inline retry affordance. */
  isSendFailed?: boolean;
  onRetrySend?: (messageId: string) => void;
  onPendingImageClick?: (file: File) => void;
  onQuote?: (messageId: string, excerpt: string) => void;
  onReplyInThread?: (messageId: string) => void;
  threadSummary?: { thread_id: string; reply_count: number; last_reply_at: string | null; thread_title: string } | null;
  isThreadRoot?: boolean;
  onAgentChatOpen?: (agentId: string, targetConvId: string) => void;
}

type EmailData = {
  type: "email";
  subject: string;
  address: string;
  direction: "inbound" | "outbound";
};
type CalendarData = {
  type: "calendar";
  title: string;
  scheduledAt?: string;
  repeatInterval?: string;
};
type IssueData = {
  type: "issue";
  title: string;
  event: "created" | "status_changed" | "dispatch_failed";
  fromStatus?: string;
  toStatus?: string;
  agentId?: string;
};
type EventData = EmailData | CalendarData | IssueData;

function parseEventData(
  metadata: Record<string, unknown> | null | undefined,
  content: string,
  conversationType?: string | null,
): EventData {
  const type = eventTypeFromMessage(metadata, content, conversationType);

  if (type === "email") {
    if (metadata?.subject) {
      return {
        type: "email",
        subject: metadata.subject as string,
        address: (metadata.direction === "inbound" ? metadata.from : metadata.to) as string,
        direction: metadata.direction as "inbound" | "outbound",
      };
    }
    const sent = /^Email sent to (.+?): ([\s\S]+)$/.exec(content);
    if (sent) return { type: "email", subject: sent[2], address: sent[1], direction: "outbound" };
    const inbound = /^New email from (.+?): ([\s\S]+)$/.exec(content);
    if (inbound) return { type: "email", subject: inbound[2], address: inbound[1], direction: "inbound" };
    const colon = content.indexOf(": ");
    return {
      type: "email",
      subject: colon > -1 ? content.slice(colon + 2) : content,
      address: "",
      direction: "inbound",
    };
  }

  if (type === "issue") {
    if (metadata?.event) {
      return {
        type: "issue",
        title: (metadata.title as string) ?? content.replace(/^Issue (?:created|opened|status changed):?\s*/i, ""),
        event: metadata.event as "created" | "status_changed" | "dispatch_failed",
        fromStatus: metadata.fromStatus as string | undefined,
        toStatus: metadata.toStatus as string | undefined,
        agentId: metadata.agentId as string | undefined,
      };
    }
    const status = /^Issue status changed: ([\s\S]+?) -> ([\s\S]+)$/.exec(content);
    if (status) return { type: "issue", title: `${status[1]} → ${status[2]}`, event: "status_changed", fromStatus: status[1], toStatus: status[2] };
    const created = /^Issue (?:created|opened): ([\s\S]+)$/.exec(content);
    if (created) return { type: "issue", title: created[1], event: "created" };
    if (/dispatch failed/i.test(content)) return { type: "issue", title: content.replace(/^Issue dispatch failed:?\s*/i, ""), event: "dispatch_failed" };
    return { type: "issue", title: content.replace(/^Issue:?\s*/i, ""), event: "created" };
  }

  // calendar
  if (metadata?.title) {
    return {
      type: "calendar",
      title: metadata.title as string,
      scheduledAt: metadata.scheduledAt as string | undefined,
      repeatInterval: metadata.repeatInterval as string | undefined,
    };
  }
  return { type: "calendar", title: content.replace(/^Calendar event:\s*/i, "") };
}

function AttachmentChips({
  attachmentIds,
  artifacts,
  onArtifactClick,
}: {
  attachmentIds: string[];
  artifacts: Artifact[];
  onArtifactClick: (a: Artifact) => void;
}) {
  const matched = attachmentIds
    .map((id) => artifacts.find((a) => a.id === id))
    .filter((a): a is Artifact => !!a)
    .filter((a) => !a.content_type.startsWith("image/"));

  if (matched.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {matched.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={(e) => { e.stopPropagation(); onArtifactClick(a); }}
          className="inline-flex items-center gap-1 rounded-md bg-primary-foreground/10 border border-primary-foreground/20 px-2 py-1 text-xs text-primary-foreground/80 hover:bg-primary-foreground/20 transition-colors cursor-pointer"
        >
          <FileText className="size-3 shrink-0" />
          <span className="truncate max-w-37.5">{a.filename}</span>
        </button>
      ))}
    </div>
  );
}

function ImageAttachmentCards({
  attachmentIds,
  artifacts,
  workspaceId,
  onArtifactClick,
}: {
  attachmentIds: string[];
  artifacts: Artifact[];
  workspaceId: string;
  onArtifactClick: (a: Artifact) => void;
}) {
  const images = attachmentIds
    .map((id) => artifacts.find((a) => a.id === id))
    .filter((a): a is Artifact => !!a && a.content_type.startsWith("image/"));

  if (images.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {images.map((a) => {
        const thumbUrl = a.has_thumbnail
          ? getArtifactThumbnailUrl(a.id, workspaceId)
          : undefined;
        return thumbUrl ? (
          <button
            key={a.id}
            type="button"
            onClick={(e) => { e.stopPropagation(); onArtifactClick(a); }}
            className="max-w-48 overflow-hidden rounded-(--radius) border border-(--border) cursor-pointer [transition:translate_.2s_cubic-bezier(.2,.8,.2,1),box-shadow_.2s_ease] hover:-translate-y-0.5 [box-shadow:var(--e1)] hover:[box-shadow:var(--e2)]"
          >
            <img src={thumbUrl} alt={a.filename} loading="lazy" className="block w-full h-auto" />
          </button>
        ) : (
          <button
            key={a.id}
            type="button"
            onClick={(e) => { e.stopPropagation(); onArtifactClick(a); }}
            className="inline-flex items-center gap-1 rounded-md bg-primary-foreground/10 border border-primary-foreground/20 px-2 py-1 text-xs text-primary-foreground/80 hover:bg-primary-foreground/20 transition-colors cursor-pointer"
          >
            <ImageIcon className="size-3 shrink-0" />
            <span className="truncate max-w-37.5">{a.filename}</span>
          </button>
        );
      })}
    </div>
  );
}

// Slack/Discord cluster model: delegates to <MessageCluster> from
// chat-primitives. This wrapper adapts the product's AnimatedAvatar + the
// `forceSpacer` concept into the primitive's props interface.

export function AgentRow({
  groupPosition,
  agentName,
  config,
  forceSpacer = false,
  children,
}: {
  groupPosition: GroupPosition;
  agentName: string;
  config: AvatarConfig | null;
  forceSpacer?: boolean;
  children: React.ReactNode;
}) {
  const effectivePosition: GroupPosition = forceSpacer ? "middle" : groupPosition;
  return (
    <MessageCluster
      avatar={
        config ? (
          <AnimatedAvatar
            config={config}
            size={AVATAR_SIZE}
            className="rounded-md"
            isHovered={false}
          />
        ) : null
      }
      name={agentName}
      position={effectivePosition}
    >
      {children}
    </MessageCluster>
  );
}

// One per-message action (Copy / Flag / …). Rendered as a toolbar icon button
// (desktop hover) or a sheet row (touch long-press) — same descriptor, two
// presentations.
interface MessageAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  /** Persistent on-state (e.g. flagged) — shown full-contrast in both surfaces. */
  active?: boolean;
}

// Desktop: a small horizontal toolbar pinned to the bubble's TOP-RIGHT corner,
// overlapping it (sits above the bubble top so it never covers text), fading in
// on hover. Always right-anchored regardless of message role.
function MessageActionsToolbar({
  actions,
}: {
  actions: MessageAction[];
}) {
  if (actions.length === 0) return null;
  return (
    <div
      className={cn(
        "absolute -top-3 right-0 z-10 flex items-center gap-1 rounded-lg border bg-card p-1 shadow-sm",
        // Fade-only reveal (reduced-motion safe — no transform/lift).
        "opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100",
      )}
    >
      {actions.map((a) => (
        <Tooltip key={a.key}>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={a.label}
                onClick={(e) => {
                  e.stopPropagation();
                  a.onClick();
                }}
                className={cn(
                  a.active ? "text-foreground" : "text-muted-foreground",
                )}
              />
            }
          >
            {a.icon}
          </TooltipTrigger>
          <TooltipContent>{a.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

// Touch: the same actions as a bottom action sheet, opened by long-pressing the
// bubble. No persistently-visible on-bubble controls (the clutter we removed).
function MessageActionsSheet({
  open,
  onOpenChange,
  actions,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  actions: MessageAction[];
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" showCloseButton={false} className="rounded-t-2xl p-2">
        <div className="flex flex-col">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() => {
                a.onClick();
                onOpenChange(false);
              }}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-3 text-left text-[0.95rem] active:bg-muted",
                a.active ? "text-foreground" : "text-foreground",
              )}
            >
              <span className="text-muted-foreground">{a.icon}</span>
              {a.label}
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// Persistent, glanceable flagged marker that lives on the BUBBLE itself (not in
// the action UI), so a flagged message reads as flagged whether or not the
// toolbar/sheet is open. Monochrome corner dot; paired with an inset left rail
// on the bubble. Bubble-only — non-bubble cases (runtime error / failed stream)
// use the existing row-tint instead.
function FlagDot() {
  return (
    <span
      aria-hidden
      className="absolute -left-2 -top-2 z-10 flex size-3.5 items-center justify-center rounded-full border-2 border-background bg-foreground text-background"
    >
      <Flag className="size-2 fill-current" />
    </span>
  );
}

function ThreadRootDot() {
  return (
    <span
      aria-hidden
      className="absolute -left-2 -top-2 z-10 flex size-3.5 items-center justify-center rounded-full border-2 border-background bg-foreground text-background"
    >
      <MessageSquare className="size-2" />
    </span>
  );
}

export const MessageItem = memo(function MessageItem({
  msg,
  agents,
  artifacts,
  activeTask,
  activeTaskStreamMsgId,
  taskMessages,
  connectionLost,
  conversationType,
  pendingFilesByMessage,
  workspaceId,
  onArtifactClick,
  onEmailClick,
  onIssueClick,
  onCalendarEventClick,
  onRetry,
  mentionComponents,
  isFlagged,
  onToggleFlag,
  groupPosition = "solo",
  provider,
  agentName,
  agentAvatarConfig,
  isSendFailed,
  onPendingImageClick,
  onRetrySend,
  onQuote,
  onReplyInThread,
  threadSummary,
  isThreadRoot,
  onAgentChatOpen,
}: MessageItemProps) {
  const { copy, copied } = useCopyToClipboard();

  // TaskStream owns this assistant message only while the task is still live OR
  // it failed (it surfaces stream/task-level errors + Retry). A COMPLETED reply
  // — and a cancelled/superseded notice — falls through to the clean bubble
  // path below; otherwise the finished reply would render nowhere (TaskStream
  // no longer renders success text).
  const hasTaskStream =
    !!activeTask &&
    msg.role === "assistant" &&
    msg.task_id === activeTask.id &&
    msg.conversation_id === activeTask.conversation_id &&
    // Only the designated (last) assistant message of the active task carries
    // the stream — so multiple `send-dm` replies don't each wrap it. When the
    // parent didn't compute an id (legacy callers), fall back to per-message.
    (activeTaskStreamMsgId == null || msg.id === activeTaskStreamMsgId) &&
    taskMessages.length > 0 &&
    !["completed", "cancelled", "superseded"].includes(activeTask.status);

  // TaskStream renders only errors / connection-lost now. When it has nothing to
  // show (a plain running task), skip its wrapper entirely so we don't paint a
  // lone avatar in an empty gutter void.
  const streamHasContent =
    hasTaskStream &&
    (taskMessages.some((m) => m.type === "error") ||
      (activeTask!.status === "failed" && !!activeTask!.error) ||
      connectionLost);

  const isTaskDone = hasTaskStream && activeTask?.status === "failed";

  // Lifecycle notice (cancelled/superseded) — a system line, not agent speech.
  // Match the durable metadata flag, with a content fallback for older rows.
  const isLifecycleNote =
    msg.role === "assistant" &&
    (msg.metadata?.kind === "lifecycle" ||
      msg.content === "Task cancelled by you" ||
      msg.content === "Task cancelled by user");

  // Per-message actions: one descriptor list, two presentations (hover toolbar
  // on hover-capable devices, long-press action sheet on touch). Copy is
  // available on both user and assistant messages; Flag is assistant-only
  // (flagging your own message is meaningless). Capability is detected, not
  // viewport-sized, so a touch laptop gets the sheet and a desktop stays hover.
  const hoverCapable = useHoverCapable();
  const [actionSheetOpen, setActionSheetOpen] = React.useState(false);

  const doCopy = React.useCallback(async () => {
    const ok = await copy(msg.content);
    if (ok) toast.success("Copied to clipboard");
    else toast.error("Failed to copy");
  }, [copy, msg.content]);

  const canCopy = msg.role === "assistant" || msg.role === "user";
  const messageActions: MessageAction[] = [];
  if (canCopy) {
    messageActions.push({
      key: "copy",
      label: copied ? "Copied" : "Copy",
      icon: copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />,
      onClick: doCopy,
    });
  }
  if (onQuote && (msg.role === "assistant" || msg.role === "user")) {
    messageActions.push({
      key: "quote",
      label: "Quote",
      icon: <MessageSquareQuote className="size-3.5" />,
      onClick: () => onQuote(msg.id, msg.content.slice(0, 50)),
    });
  }
  if (onReplyInThread && (msg.role === "assistant" || msg.role === "user")) {
    messageActions.push({
      key: "thread",
      label: "Reply in thread",
      icon: <MessageSquare className="size-3.5" />,
      onClick: () => onReplyInThread(msg.id),
    });
  }
  if (msg.role === "assistant" && onToggleFlag) {
    messageActions.push({
      key: "flag",
      label: isFlagged ? "Unflag" : "Flag",
      icon: <Flag className={cn("size-3.5", isFlagged && "fill-current")} />,
      onClick: () => onToggleFlag(msg.id),
      active: isFlagged,
    });
  }

  // Long-press (touch only) opens the action sheet. Cancels on movement so it
  // never hijacks text selection. Spread onto the bubble's interactive surface.
  const longPress = useLongPress(() => {
    if (messageActions.length > 0) setActionSheetOpen(true);
  });
  // On hover-capable devices, no long-press handlers (mouse keeps select/click).
  const bubblePressHandlers = !hoverCapable && messageActions.length > 0 ? longPress : {};

  // The shared touch sheet — rendered once per message, opened by long-press.
  const actionSheet =
    !hoverCapable && messageActions.length > 0 ? (
      <MessageActionsSheet
        open={actionSheetOpen}
        onOpenChange={setActionSheetOpen}
        actions={messageActions}
      />
    ) : null;

  // The desktop hover toolbar for a given side. Only on hover-capable devices.
  const toolbar =
    hoverCapable && messageActions.length > 0 ? (
      <MessageActionsToolbar actions={messageActions} />
    ) : null;

  return (
    <React.Fragment>
      {hasTaskStream && streamHasContent && (
        <div
          className={cn("group/msg", isFlagged && "bg-muted/30 rounded-lg px-2 -mx-2")}
          {...(isTaskDone ? { "data-quote-source": true } : {})}
        >
          <AgentRow groupPosition={groupPosition} agentName={agentName} config={agentAvatarConfig}>
            <div
              className="relative min-w-0 w-fit max-w-full"
              {...(isTaskDone ? bubblePressHandlers : {})}
            >
              <TaskStream
                task={activeTask}
                messages={taskMessages}
                connectionLost={connectionLost}
                onRetry={onRetry}
                provider={provider}
              />
              {isTaskDone && toolbar}
              {isTaskDone && actionSheet}
            </div>
          </AgentRow>
        </div>
      )}
      {msg.role === "user" ? (() => {
        const slashMatch = msg.content.match(/^\/(\S+)\s?([\s\S]*)$/);
        const skillName = slashMatch?.[1] ?? null;
        const messageBody = slashMatch ? (slashMatch[2] || "") : msg.content;
        return (
          <div className="group/msg flex flex-col items-end" data-message-id={msg.id} {...(msg.task_id ? { "data-task-id": msg.task_id } : {})}>
            {(() => {
              const quote = msg.metadata?.quote as { messageId?: string; excerpt?: string } | undefined;
              const quoteId = quote?.messageId;
              if (!quoteId) return null;
              return (
                <button
                  type="button"
                  onClick={() => {
                    const target = document.querySelector(`[data-message-id="${CSS.escape(quoteId)}"]`);
                    target?.scrollIntoView({ behavior: "smooth", block: "center" });
                  }}
                  className="max-w-[50%] mb-1 flex items-center gap-2 rounded-lg bg-muted/60 px-2 py-1 text-left"
                >
                  <MessageSquareQuote className="size-3 shrink-0 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground truncate">{quote.excerpt}</span>
                </button>
              );
            })()}
            <MessageBubble
              variant="user"
              position={toBubblePosition(groupPosition)}
              className={cn(
                "max-w-[80%] relative",
                isSendFailed && "opacity-60",
              )}
              {...bubblePressHandlers}
            >
              {skillName && (
                <span className="inline-flex items-center rounded px-2 py-1 text-xs font-medium bg-primary-foreground/15 text-primary-foreground mb-1">
                  /{skillName}
                </span>
              )}
              {messageBody && (
                <div className="markdown markdown-user">
                  <Streamdown plugins={{ mermaid, cjk, math }} controls={{ code: { copy: true, download: false }, table: { copy: false, download: false, fullscreen: false } }} linkSafety={{ enabled: false }} allowedTags={MENTION_ALLOWED_TAGS} literalTagContent={MENTION_LITERAL_TAGS} components={mentionComponents}>{highlightMentions(messageBody, agents)}</Streamdown>
                </div>
              )}
              {(() => {
                // Non-image file chips inside the bubble.
                // Prefer local pending pills (instant) to avoid flash on transition.
                const pfs = pendingFilesByMessage.get(msg.id);
                const nonImagePfs = pfs?.filter((pf) => !pf.thumbnailUrl);
                if (nonImagePfs && nonImagePfs.length > 0) {
                  return (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {nonImagePfs.map((pf, i) => (
                        <span key={i} className="inline-flex items-center gap-1 rounded-md bg-primary-foreground/10 border border-primary-foreground/20 px-2 py-1 text-xs text-primary-foreground/80">
                          <FileText className="size-3 shrink-0" />
                          <span className="truncate max-w-37.5">{pf.file.name}</span>
                        </span>
                      ))}
                    </div>
                  );
                }
                const ids = msg.attachment_ids;
                if (ids && ids.length > 0) {
                  const resolved = ids.map((id: string) => artifacts.find((a) => a.id === id)).filter((a): a is Artifact => !!a);
                  const nonImageResolved = resolved.filter((a) => !a.content_type.startsWith("image/"));
                  if (nonImageResolved.length > 0) return <AttachmentChips attachmentIds={nonImageResolved.map((a) => a.id)} artifacts={artifacts} onArtifactClick={onArtifactClick} />;
                }
                return null;
              })()}
              {toolbar}
            </MessageBubble>
            {(() => {
              // Image thumbnail cards below the bubble.
              // Prefer local blob thumbnails (instant, no network fetch) over
              // server thumbnails to avoid a flash when transitioning sources.
              const pfs = pendingFilesByMessage.get(msg.id);
              const imagePfs = pfs?.filter((pf) => pf.thumbnailUrl);
              if (imagePfs && imagePfs.length > 0) {
                return (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {imagePfs.map((pf, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onPendingImageClick?.(pf.file); }}
                        className="max-w-48 overflow-hidden rounded-(--radius) border border-(--border) cursor-pointer [transition:translate_.2s_cubic-bezier(.2,.8,.2,1),box-shadow_.2s_ease] hover:-translate-y-0.5 [box-shadow:var(--e1)] hover:[box-shadow:var(--e2)]"
                      >
                        <img src={pf.thumbnailUrl!} alt={pf.file.name} className="block w-full h-auto" />
                      </button>
                    ))}
                  </div>
                );
              }
              const ids = msg.attachment_ids;
              if (ids && ids.length > 0) {
                const resolved = ids.map((id: string) => artifacts.find((a) => a.id === id)).filter((a): a is Artifact => !!a);
                const imageResolved = resolved.filter((a) => a.content_type.startsWith("image/"));
                if (imageResolved.length > 0) return <ImageAttachmentCards attachmentIds={imageResolved.map((a) => a.id)} artifacts={artifacts} workspaceId={workspaceId} onArtifactClick={onArtifactClick} />;
              }
              return null;
            })()}
            {actionSheet}
            {isSendFailed && (
              <button
                type="button"
                onClick={() => onRetrySend?.(msg.id)}
                className="mt-1 px-1 text-xs text-destructive hover:underline"
              >
                Not delivered · tap to retry
              </button>
            )}
            {threadSummary && threadSummary.reply_count > 0 && (
              <button
                type="button"
                onClick={() => onReplyInThread?.(msg.id)}
                className="flex items-center gap-2 pt-1 cursor-pointer hover:opacity-75 transition-opacity"
              >
                <span className="text-[11px] font-semibold text-[oklch(0.72_0.19_145)]">
                  {threadSummary.reply_count} {threadSummary.reply_count === 1 ? "reply" : "replies"}
                </span>
                {threadSummary.last_reply_at && (
                  <span className="text-[10px] text-muted-foreground">
                    last reply {new Date(threadSummary.last_reply_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </button>
            )}
          </div>
        );
      })() : msg.role === "event" ? (() => {
        const eventEmailId = msg.metadata?.emailId as string | undefined;
        const eventIssueId = msg.metadata?.issueId as string | undefined;
        const eventCalendarEventId = msg.metadata?.calendarEventId as string | undefined;
        const onClick = eventEmailId
          ? () => onEmailClick(eventEmailId)
          : eventIssueId
            ? () => onIssueClick(eventIssueId)
            : eventCalendarEventId
              ? () => onCalendarEventClick(eventCalendarEventId)
              : undefined;
        const data = parseEventData(msg.metadata, msg.content, conversationType);
        let card: React.ReactNode;
        if (data.type === "email") {
          const handle = parseEmailHandle(data.address);
          const targetConvId = msg.metadata?.targetConversationId as string | undefined;
          const targetAgentId = msg.metadata?.targetAgentId as string | undefined;
          const isInternalEmail = !!handle;
          let touchAction: { label: string; onClick: () => void } | null = null;
          if (isInternalEmail && !hoverCapable && targetConvId && targetAgentId && onAgentChatOpen) {
            const agentName = agents.find(a => a.email_handle === handle)?.name;
            if (agentName) {
              touchAction = {
                label: `View ${agentName}'s conversation`,
                onClick: () => onAgentChatOpen(targetAgentId, targetConvId),
              };
            }
          }
          card = (
            <EmailCard
              subject={data.subject}
              address={data.address}
              direction={data.direction}
              onClick={onClick}
              timestamp={msg.created_at}
              {...(hoverCapable && isInternalEmail ? {
                isInternal: true,
                internalHandle: handle || undefined,
                targetConvId,
                targetAgentId,
                agents,
                onAgentChatOpen,
              } : {})}
              touchAction={touchAction}
            />
          );
        } else if (data.type === "calendar") {
          card = <CalendarCard title={data.title} scheduledAt={data.scheduledAt} repeatInterval={data.repeatInterval} onClick={onClick} />;
        } else {
          card = <IssueCard title={data.title} event={data.event} fromStatus={data.fromStatus} toStatus={data.toStatus} assigneeName={data.agentId ? agents.find(a => a.id === data.agentId)?.name : undefined} onClick={onClick} />;
        }
        return (
          <div data-message-id={msg.id} {...(msg.task_id ? { "data-task-id": msg.task_id } : {})}>
            <AgentRow groupPosition={groupPosition} agentName={agentName} config={agentAvatarConfig}>
              {card}
            </AgentRow>
          </div>
        );
      })() : isLifecycleNote && msg.metadata?.error_source !== "runtime" ? (
        // Lifecycle note (e.g. "Task cancelled by user") — a quiet centered
        // system line, not agent speech. No bubble, no avatar gutter.
        <div className="flex justify-center" data-message-id={msg.id} {...(msg.task_id ? { "data-task-id": msg.task_id } : {})}>
          <span className="text-xs text-muted-foreground/70 text-center px-2 py-1">
            {msg.content}
          </span>
        </div>
      ) : shouldRenderAssistantBody({
          hasTaskStream,
          isRuntimeError: msg.metadata?.error_source === "runtime",
        }) ? (
        // The agent's own send-dm text bubble renders even when this message is
        // the one carrying the live error stream (hasTaskStream) — the error
        // block above is ADDITIVE, not a replacement, so the reply text is never
        // swallowed (QA AC4). A runtime-error message is the exception: it IS the
        // error, surfaced by the TaskStream above while live, so it still only
        // renders its own RuntimeErrorBlock when no stream owns it (!hasTaskStream).
        <div
          className={cn(
            "group/msg overflow-x-clip",
            // Non-bubble flagged case (runtime error) → row-tint, since the
            // rail/dot is bubble-only. The normal text bubble uses the rail+dot
            // instead, so it must NOT get the tint.
            isFlagged && msg.metadata?.error_source === "runtime" && "bg-muted/30 rounded-lg px-2 -mx-2",
          )}
          data-message-id={msg.id}
          data-quote-source
          {...(msg.task_id ? { "data-task-id": msg.task_id } : {})}
        >
          <AgentRow groupPosition={groupPosition} agentName={agentName} config={agentAvatarConfig}>
            {msg.metadata?.error_source === "runtime" ? (
              // A failure is a real message, not a bubble — surface it plainly
              // with Retry. The action toolbar pins to the OPEN-side (left) top
              // corner; no on-block flag rail/dot (that's bubble-only) — a
              // flagged error uses the row-tint instead (see wrapper below).
              <div
                className="relative min-w-0 w-fit max-w-full"
                {...bubblePressHandlers}
              >
                <RuntimeErrorBlock
                  provider={(msg.metadata.provider as string | null | undefined) ?? provider}
                  message={msg.content}
                />
                {toolbar}
                {actionSheet}
              </div>
            ) : (
              <div
                className="relative min-w-0 w-fit max-w-full"
                {...bubblePressHandlers}
              >
                <MessageBubble
                  variant="agent"
                  position={toBubblePosition(groupPosition)}
                  className={cn(
                    "markdown min-w-0 max-w-full",
                    (isFlagged || isThreadRoot) && "shadow-[inset_2px_0_0_var(--foreground)]",
                  )}
                >
                  <Streamdown plugins={{ mermaid, cjk, math }} controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: true } }} linkSafety={{ enabled: false }} allowedTags={MENTION_ALLOWED_TAGS} literalTagContent={MENTION_LITERAL_TAGS} components={mentionComponents}>{highlightMentions(msg.content, agents)}</Streamdown>
                </MessageBubble>
                {isFlagged && !isThreadRoot && <FlagDot />}
                {isThreadRoot && <ThreadRootDot />}
                {toolbar}
                {actionSheet}
              </div>
            )}
            {threadSummary && threadSummary.reply_count > 0 && (
              <button
                type="button"
                onClick={() => onReplyInThread?.(msg.id)}
                className="flex items-center gap-2 pt-1 cursor-pointer hover:opacity-75 transition-opacity"
              >
                <span className="text-[11px] font-semibold text-[oklch(0.72_0.19_145)]">
                  {threadSummary.reply_count} {threadSummary.reply_count === 1 ? "reply" : "replies"}
                </span>
                {threadSummary.last_reply_at && (
                  <span className="text-[10px] text-muted-foreground">
                    last reply {new Date(threadSummary.last_reply_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </button>
            )}
          </AgentRow>
        </div>
      ) : null}
    </React.Fragment>
  );
});
