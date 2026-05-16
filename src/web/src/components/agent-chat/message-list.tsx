import React, { memo, useState } from "react";
import type { Agent, Artifact, Message, TaskApi as Task, TaskMessage } from "@alook/shared";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Streamdown } from "streamdown";
import { highlightMentions } from "@/lib/highlight-mentions";
import { TaskStream } from "@/components/task-stream";
import { HistoricalTaskSteps } from "@/components/agent-chat/historical-task-steps";
import { FileText, Calendar, CircleDot, Mail, Flag, Copy, Check } from "lucide-react";

import { getEventIconType } from "@/components/agent-chat/agent-chat-view";
import { toast } from "sonner";

const MENTION_ALLOWED_TAGS = { mention: ["data-agent-id"] };
const MENTION_LITERAL_TAGS = ["mention"];

export interface MessageItemProps {
  msg: Message;
  agents: Agent[];
  artifacts: Artifact[];
  activeTask: Task | null;
  taskMessages: TaskMessage[];
  connectionLost: boolean;
  isLastMessage: boolean;
  stepCount: number;
  targetConvId: string | null;
  workspaceId: string;
  conversationType?: string | null;
  pendingFilesByMessage: Map<string, File[]>;
  onArtifactClick: (a: Artifact) => void;
  onEmailClick: (emailId: string) => void;
  onIssueClick: (issueId: string) => void;
  onRetry?: () => void;
  mentionComponents: Record<string, React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>>;
  isFlagged?: boolean;
  onToggleFlag?: (messageId: string) => void;
}

function EventMessageIcon({ content, conversationType }: { content: string; conversationType?: string | null }) {
  const iconType = getEventIconType(content, conversationType);
  const className = "h-4 w-4 mt-0.5 shrink-0";

  if (iconType === "issue") return <CircleDot className={className} />;
  if (iconType === "email") return <Mail className={className} />;
  return <Calendar className={className} />;
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

export const MessageItem = memo(function MessageItem({
  msg,
  agents,
  artifacts,
  activeTask,
  taskMessages,
  connectionLost,
  isLastMessage,
  stepCount,
  targetConvId,
  workspaceId,
  conversationType,
  pendingFilesByMessage,
  onArtifactClick,
  onEmailClick,
  onIssueClick,
  onRetry,
  mentionComponents,
  isFlagged,
  onToggleFlag,
}: MessageItemProps) {
  const [copied, setCopied] = useState(false);

  const hasTaskStream =
    activeTask &&
    msg.role === "assistant" &&
    msg.task_id === activeTask.id &&
    msg.conversation_id === activeTask.conversation_id &&
    taskMessages.length > 0;

  const historicalStepCount =
    !hasTaskStream &&
    targetConvId &&
    msg.role === "assistant" &&
    msg.task_id &&
    stepCount > 0
      ? stepCount
      : 0;

  const isTaskDone = hasTaskStream && activeTask && ["completed", "failed", "cancelled", "superseded"].includes(activeTask.status);

  const actionButtons = msg.role === "assistant" ? (
    <div className="flex flex-row items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={copied ? "Copied" : "Copy message"}
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  await navigator.clipboard.writeText(msg.content);
                  setCopied(true);
                  toast.success("Copied to clipboard");
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  toast.error("Failed to copy");
                }
              }}
              className={cn(
                "self-start mb-1",
                copied
                  ? "text-green-500 opacity-100"
                  : "text-muted-foreground opacity-0 group-hover/msg:opacity-100"
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
                  "self-start mb-1",
                  isFlagged
                    ? "text-primary opacity-100"
                    : "text-muted-foreground opacity-0 group-hover/msg:opacity-100"
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
      {hasTaskStream && (
        <div className={cn(
          "group/msg",
          isFlagged && "bg-muted/30 rounded-lg px-2 -mx-2"
        )}>
          <TaskStream
            task={activeTask}
            messages={taskMessages}
            connectionLost={connectionLost}
            onRetry={onRetry}
          />
          {isTaskDone && actionButtons}
        </div>
      )}
      {historicalStepCount > 0 && msg.task_id && (
        <HistoricalTaskSteps
          taskId={msg.task_id}
          stepCount={historicalStepCount}
          workspaceId={workspaceId}
        />
      )}
      {msg.role === "user" ? (() => {
        const awaitingRun = isLastMessage && !!activeTask && activeTask.status !== "running" && !["completed", "failed", "cancelled", "superseded"].includes(activeTask.status);
        return (
          <div className="flex justify-end" data-message-id={msg.id} {...(msg.task_id ? { "data-task-id": msg.task_id } : {})}>
            <div className={cn(
              "max-w-[80%] rounded-lg px-4 py-2 bg-primary text-primary-foreground text-base relative",
            )}>
              {awaitingRun && (
                <div className="absolute inset-0 rounded-lg animate-pulse pointer-events-none" style={{ boxShadow: "0 0 0 2px var(--bubble-glow)" }} />
              )}
              <div className="markdown markdown-user">
                <Streamdown controls={{ code: { copy: true, download: false }, table: { copy: false, download: false, fullscreen: false } }} linkSafety={{ enabled: false }} allowedTags={MENTION_ALLOWED_TAGS} literalTagContent={MENTION_LITERAL_TAGS} components={mentionComponents}>{highlightMentions(msg.content, agents)}</Streamdown>
              </div>
              {msg.attachment_ids && msg.attachment_ids.length > 0 && (
                <AttachmentChips attachmentIds={msg.attachment_ids} artifacts={artifacts} onArtifactClick={onArtifactClick} />
              )}
              {!msg.attachment_ids && (
                <PendingFileChips pendingFiles={pendingFilesByMessage} messageId={msg.id} />
              )}
            </div>
          </div>
        );
      })() : msg.role === "event" ? (() => {
        const eventEmailId = msg.metadata?.emailId as string | undefined;
        const eventIssueId = msg.metadata?.issueId as string | undefined;
        const isClickable = !!eventEmailId || !!eventIssueId;
        return (
          <div className="flex justify-start" data-message-id={msg.id} {...(msg.task_id ? { "data-task-id": msg.task_id } : {})}>
            <div
              className={cn(
                "w-full rounded-md border bg-muted/50 text-muted-foreground text-sm px-3 py-2 flex items-start gap-2",
                isClickable && "cursor-pointer hover:bg-muted transition-colors"
              )}
              onClick={eventEmailId ? () => onEmailClick(eventEmailId) : eventIssueId ? () => onIssueClick(eventIssueId) : undefined}
            >
              <EventMessageIcon content={msg.content} conversationType={conversationType} />
              <span>{msg.content}</span>
            </div>
          </div>
        );
      })() : !hasTaskStream ? (
        <div className={cn(
          "group/msg flex flex-col justify-start",
          isFlagged && "bg-muted/30 rounded-lg px-2 -mx-2"
        )} data-message-id={msg.id} data-quote-source {...(msg.task_id ? { "data-task-id": msg.task_id } : {})}>
          <div className="markdown max-w-full min-w-0 px-1 py-1 text-base text-foreground">
            <Streamdown controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: true } }} linkSafety={{ enabled: false }} allowedTags={MENTION_ALLOWED_TAGS} literalTagContent={MENTION_LITERAL_TAGS} components={mentionComponents}>{highlightMentions(msg.content, agents)}</Streamdown>
          </div>
          {actionButtons}
        </div>
      ) : null}
    </React.Fragment>
  );
});
