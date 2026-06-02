import React, { memo } from "react";
import type { Agent, Artifact, Message, TaskApi as Task, TaskMessageResponse } from "@alook/shared";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Streamdown } from "streamdown";
import { mermaid, cjk } from "@/lib/streamdown-plugins";
import { highlightMentions } from "@/lib/highlight-mentions";
import { TaskStream } from "@/components/task-stream";
import { RuntimeErrorBlock } from "@/components/agent-chat/runtime-error-block";
import { AnimatedAvatar, type AvatarConfig } from "@/components/avatar";
import { FileText, Calendar, CircleDot, Mail, Flag, Copy, Check, ChevronRight } from "lucide-react";

import { eventTypeFromMessage, type GroupPosition } from "@/components/agent-chat/chat-message-utils";
import { toast } from "sonner";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

const MENTION_ALLOWED_TAGS = { mention: ["data-agent-id"] };
const MENTION_LITERAL_TAGS = ["mention"];

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
  pendingFilesByMessage: Map<string, File[]>;
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
}

/**
 * Shared visual shell for agent-side system cards (event + artifact). A tinted
 * icon chip, an uppercase label, a title line, and an OPTIONAL muted preview
 * line. Height follows content — a 2-line card (no preview) is genuinely
 * shorter; we never reserve a blank row to force parity (Gus). Hairline border,
 * quiet chevron, hover lift. Monochrome.
 */
export function SystemCard({
  icon: Icon,
  label,
  title,
  preview,
  trailing,
  onClick,
}: {
  icon: typeof Mail;
  label: string;
  title: string;
  preview?: string | null;
  /** Optional inline element after the title (e.g. an artifact version badge). */
  trailing?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        // Fixed footprint so email / issue / calendar / file cards are uniform
        // when stacked — width + height don't follow content (Gus, 2026-06-01).
        // h fits the 3-line variant; overflow-hidden + per-line truncate keep
        // any longer content from spilling past the fixed box.
        "group/card w-[26rem] max-w-full h-[4.75rem] overflow-hidden text-left rounded-md border bg-card",
        "flex items-center gap-3 px-3 py-2",
        onClick &&
          "cursor-pointer transition-all duration-150 hover:-translate-y-px hover:shadow-sm hover:border-foreground/15",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {label}
        </span>
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          {trailing}
        </span>
        {preview ? (
          <span className="truncate text-xs text-muted-foreground">{preview}</span>
        ) : null}
      </span>
      {onClick && (
        <ChevronRight className="size-4 shrink-0 self-center text-muted-foreground/40 transition-colors duration-150 group-hover/card:text-muted-foreground" />
      )}
    </button>
  );
}

// Parse the honest label / title / preview out of a system-event message. The
// card describes the EVENT (an immutable historical fact), never live state —
// so no "current status" pill. Preview is honest or omitted (Gus/Priya).
//   Email:    "New email from {sender}: {subject}" | "Email sent to {recipient}: {subject}"
//   Issue:    "Issue created/opened: {title}" | "Issue status changed: {X} -> {Y}"
//   Calendar: "{title}" (sometimes "Calendar event: {title}")
function parseEventCard(
  type: "issue" | "email" | "calendar",
  content: string,
): { label: string; title: string; preview?: string } {
  if (type === "email") {
    const sent = /^Email sent to (.+?): ([\s\S]+)$/.exec(content);
    if (sent) return { label: "EMAIL", title: sent[2], preview: `to ${sent[1]}` };
    const inbound = /^New email from (.+?): ([\s\S]+)$/.exec(content);
    if (inbound) return { label: "EMAIL", title: inbound[2], preview: `from ${inbound[1]}` };
    const colon = content.indexOf(": ");
    return colon > -1
      ? { label: "EMAIL", title: content.slice(colon + 2) }
      : { label: "EMAIL", title: content };
  }
  if (type === "issue") {
    const status = /^Issue status changed: ([\s\S]+?) -> ([\s\S]+)$/.exec(content);
    // The status transition is the immutable event fact — show it as the preview.
    if (status) return { label: "ISSUE", title: "Status changed", preview: `Status: ${status[1]} → ${status[2]}` };
    const created = /^Issue (?:created|opened): ([\s\S]+)$/.exec(content);
    if (created) return { label: "ISSUE", title: created[1] }; // 2-line: no honest preview
    return { label: "ISSUE", title: content.replace(/^Issue:?\s*/i, "") };
  }
  // calendar — title only; strip a "Calendar event:" prefix if present. No
  // datetime/repeat preview unless it is later stamped into the message.
  return { label: "CALENDAR", title: content.replace(/^Calendar event:\s*/i, "") };
}

/**
 * System event (email / issue / calendar) as a clickable card. Type + icon are
 * metadata-driven (msg.metadata.{issueId,emailId,calendarEventId}), falling back
 * to the content heuristic only if metadata is absent.
 */
function EventCard({
  content,
  metadata,
  conversationType,
  onClick,
}: {
  content: string;
  metadata?: Record<string, unknown> | null;
  conversationType?: string | null;
  onClick?: () => void;
}) {
  const type = eventTypeFromMessage(metadata, content, conversationType);
  const Icon = type === "issue" ? CircleDot : type === "email" ? Mail : Calendar;
  const { label, title, preview } = parseEventCard(type, content);
  return <SystemCard icon={Icon} label={label} title={title} preview={preview} onClick={onClick} />;
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
    .filter((a): a is Artifact => !!a);

  if (matched.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {matched.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={(e) => { e.stopPropagation(); onArtifactClick(a); }}
          className="inline-flex items-center gap-1 rounded-md bg-primary-foreground/10 border border-primary-foreground/20 px-2 py-0.5 text-xs text-primary-foreground/80 hover:bg-primary-foreground/20 transition-colors cursor-pointer"
        >
          <FileText className="size-3 shrink-0" />
          <span className="truncate max-w-37.5">{a.filename}</span>
        </button>
      ))}
    </div>
  );
}

function PendingFileChips({
  pendingFiles,
  messageId,
}: {
  pendingFiles: Map<string, File[]>;
  messageId: string;
}) {
  const files = pendingFiles.get(messageId);
  if (!files || files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {files.map((f, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-md bg-primary-foreground/10 border border-primary-foreground/20 px-2 py-0.5 text-xs text-primary-foreground/80"
        >
          <FileText className="size-3 shrink-0" />
          <span className="truncate max-w-37.5">{f.name}</span>
        </span>
      ))}
    </div>
  );
}

// Bubble grouping (locked prototype v2): base radius 1.05rem; the corner FACING
// the neighbor in the cluster tucks to 0.35rem. User bubbles tuck the RIGHT
// edge; agent bubbles mirror to the LEFT edge.
//   first → tuck the bottom (corner toward the next bubble)
//   middle → tuck top + bottom
//   last → tuck the top (corner toward the previous bubble)
const USER_BUBBLE_RADIUS: Record<GroupPosition, string> = {
  solo: "rounded-[1.05rem]",
  first: "rounded-[1.05rem] rounded-br-[0.35rem]",
  middle: "rounded-[1.05rem] rounded-tr-[0.35rem] rounded-br-[0.35rem]",
  last: "rounded-[1.05rem] rounded-tr-[0.35rem]",
};

const AGENT_BUBBLE_RADIUS: Record<GroupPosition, string> = {
  solo: "rounded-[1.05rem]",
  first: "rounded-[1.05rem] rounded-bl-[0.35rem]",
  middle: "rounded-[1.05rem] rounded-tl-[0.35rem] rounded-bl-[0.35rem]",
  last: "rounded-[1.05rem] rounded-tl-[0.35rem]",
};

// Slack/Discord cluster model (locked prototype): a TOP header [avatar] [name]
// on the cluster's FIRST message (first/solo); bubbles/cards stack below it in
// the gutter. Subsequent grouped messages get a spacer (no repeated
// avatar/name). The avatar is TOP-aligned to the header — it anchors to the
// name row, not a variable-height column, which dissolves the floating-avatar
// bug. `forceSpacer` keeps the gutter width but never paints a header — for
// items (e.g. an artifact card) that belong to the preceding message's cluster.
const AVATAR_SIZE = 30; // matches the prototype's 30px gutter column
const GUTTER_W = "w-[30px]";

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
  const isClusterHead =
    !forceSpacer && (groupPosition === "first" || groupPosition === "solo");
  return (
    <div className="flex justify-start items-start gap-2 min-w-0">
      <div className={cn(GUTTER_W, "shrink-0")} aria-hidden={!isClusterHead}>
        {isClusterHead && config && (
          <AnimatedAvatar
            config={config}
            size={AVATAR_SIZE}
            className="rounded-md"
            isHovered={false}
          />
        )}
      </div>
      <div className="min-w-0 max-w-[86%] flex flex-col items-start gap-0.5">
        {isClusterHead && (
          // Top-aligned with the avatar (prototype v2): tight line-height + a
          // hair of top padding so the name's top edge lines up with the avatar.
          <span className="text-[0.85rem] font-semibold text-foreground leading-[1.15] pt-0.5 mb-1">
            {agentName}
          </span>
        )}
        {children}
      </div>
    </div>
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
  onRetrySend,
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

  const actionButtons = msg.role === "assistant" ? (
    // Vertical on mobile so the right-of-bubble actions don't get clipped at
    // the screen edge; horizontal from md up where there's room.
    <div className="flex flex-col sm:flex-row items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={copied ? "Copied" : "Copy message"}
              onClick={async (e) => {
                e.stopPropagation();
                const ok = await copy(msg.content);
                if (ok) toast.success("Copied to clipboard");
                else toast.error("Failed to copy");
              }}
              className={cn(
                copied
                  ? "text-green-500 opacity-100"
                  : "text-muted-foreground sm:opacity-0 sm:group-hover/msg:opacity-100"
              )}
            />
          }
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
      </Tooltip>
      {onToggleFlag && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onToggleFlag(msg.id)}
                className={cn(
                  isFlagged
                    ? "text-primary opacity-100"
                    : "text-muted-foreground sm:opacity-0 sm:group-hover/msg:opacity-100"
                )}
              />
            }
          >
            <Flag className={cn("size-3.5", isFlagged && "fill-current")} />
          </TooltipTrigger>
          <TooltipContent>{isFlagged ? "Unflag" : "Flag"}</TooltipContent>
        </Tooltip>
      )}
    </div>
  ) : null;

  return (
    <React.Fragment>
      {hasTaskStream && streamHasContent && (
        <div
          className={cn("group/msg", isFlagged && "bg-muted/30 rounded-lg px-2 -mx-2")}
          {...(isTaskDone ? { "data-quote-source": true } : {})}
        >
          <AgentRow groupPosition={groupPosition} agentName={agentName} config={agentAvatarConfig}>
            <div className="relative min-w-0 w-fit max-w-full">
              <TaskStream
                task={activeTask}
                messages={taskMessages}
                connectionLost={connectionLost}
                onRetry={onRetry}
                provider={provider}
              />
              {isTaskDone && actionButtons && (
                <div className="absolute left-full top-0 ml-1 z-10">{actionButtons}</div>
              )}
            </div>
          </AgentRow>
        </div>
      )}
      {msg.role === "user" ? (() => {
        const slashMatch = msg.content.match(/^\/(\S+)\s?([\s\S]*)$/);
        const skillName = slashMatch?.[1] ?? null;
        const messageBody = slashMatch ? (slashMatch[2] || "") : msg.content;
        return (
          <div className="flex flex-col items-end" data-message-id={msg.id} {...(msg.task_id ? { "data-task-id": msg.task_id } : {})}>
            <div className={cn(
              "max-w-[80%] px-4 py-2 bg-primary text-primary-foreground text-base relative",
              USER_BUBBLE_RADIUS[groupPosition],
              isSendFailed && "opacity-60",
            )}>
              {skillName && (
                <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-primary-foreground/15 text-primary-foreground mb-1">
                  /{skillName}
                </span>
              )}
              {messageBody && (
                <div className="markdown markdown-user">
                  <Streamdown plugins={{ mermaid, cjk }} controls={{ code: { copy: true, download: false }, table: { copy: false, download: false, fullscreen: false } }} linkSafety={{ enabled: false }} allowedTags={MENTION_ALLOWED_TAGS} literalTagContent={MENTION_LITERAL_TAGS} components={mentionComponents}>{highlightMentions(messageBody, agents)}</Streamdown>
                </div>
              )}
              {msg.attachment_ids && msg.attachment_ids.length > 0 && (
                <AttachmentChips attachmentIds={msg.attachment_ids} artifacts={artifacts} onArtifactClick={onArtifactClick} />
              )}
              {!msg.attachment_ids && (
                <PendingFileChips pendingFiles={pendingFilesByMessage} messageId={msg.id} />
              )}
            </div>
            {isSendFailed && (
              <button
                type="button"
                onClick={() => onRetrySend?.(msg.id)}
                className="mt-1 px-1 text-xs text-destructive hover:underline"
              >
                Not delivered · tap to retry
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
        return (
          <div data-message-id={msg.id} {...(msg.task_id ? { "data-task-id": msg.task_id } : {})}>
            <AgentRow groupPosition={groupPosition} agentName={agentName} config={agentAvatarConfig}>
              <EventCard content={msg.content} metadata={msg.metadata} conversationType={conversationType} onClick={onClick} />
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
        <div className="group/msg overflow-x-clip" data-message-id={msg.id} data-quote-source {...(msg.task_id ? { "data-task-id": msg.task_id } : {})}>
          <AgentRow groupPosition={groupPosition} agentName={agentName} config={agentAvatarConfig}>
            {msg.metadata?.error_source === "runtime" ? (
              // A failure is a real message, not a bubble — surface it plainly
              // with Retry. actionButtons render as an out-of-flow top-right
              // overlay so the hidden hover row never reserves height.
              <div className="relative min-w-0 w-fit max-w-full">
                <RuntimeErrorBlock
                  provider={(msg.metadata.provider as string | null | undefined) ?? provider}
                  message={msg.content}
                />
                {actionButtons && (
                  <div className="absolute left-full top-0 ml-1 z-10">{actionButtons}</div>
                )}
              </div>
            ) : (
              <div className="relative min-w-0 w-fit max-w-full">
                <div className={cn(
                  "markdown min-w-0 max-w-full px-4 py-2 bg-muted text-foreground text-base",
                  AGENT_BUBBLE_RADIUS[groupPosition],
                )}>
                  <Streamdown plugins={{ mermaid, cjk }} controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: true } }} linkSafety={{ enabled: false }} allowedTags={MENTION_ALLOWED_TAGS} literalTagContent={MENTION_LITERAL_TAGS} components={mentionComponents}>{highlightMentions(msg.content, agents)}</Streamdown>
                </div>
                {actionButtons && (
                  <div className="absolute left-full top-0 ml-1 z-10">{actionButtons}</div>
                )}
              </div>
            )}
          </AgentRow>
        </div>
      ) : null}
    </React.Fragment>
  );
});
