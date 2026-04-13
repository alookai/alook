"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { listAgentConversations, deleteConversation } from "@/lib/api";
import type { Conversation } from "@alook/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Loader2, Trash2, MessageSquare } from "lucide-react";

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

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function AgentChatPage() {
  const params = useParams();
  const router = useRouter();
  const { slug, workspaceId } = useWorkspace();
  const agentId = params.id as string;
  const { agents, chatWithAgent } = useAgentContext();

  const agent = agents.find((a) => a.id === agentId);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Delete conversation state
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadConversations = useCallback(async () => {
    try {
      const convs = await listAgentConversations(agentId, workspaceId);
      setConversations(convs);
    } catch {
      toast.error("Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [agentId, workspaceId]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const handleNewSession = async () => {
    setCreating(true);
    try {
      const conversationId = await chatWithAgent(agentId);
      if (conversationId) {
        router.push(`/w/${slug}/agents/${agentId}/chat/${conversationId}`);
      }
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteConversation = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteConversation(deleteTarget.id, workspaceId);
      setConversations((prev) =>
        prev.filter((c) => c.id !== deleteTarget.id)
      );
      setDeleteTarget(null);
    } catch {
      toast.error("Failed to delete session");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto px-5">
        <div className="mx-auto max-w-2xl py-6">
          {/* Skeleton sessions header */}
          <div className="flex items-center justify-between mb-4">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-7 w-[106px] rounded-md" />
          </div>
          {/* Skeleton session rows */}
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="rounded-lg border border-border/50 bg-background/50 px-4 py-3"
              >
                <Skeleton className="h-4 w-48 mb-1.5" />
                <Skeleton className="h-3 w-32" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <>
        <div className="flex flex-col flex-1">
          <div className="px-5">
            <div className="mx-auto max-w-2xl pt-6">
              {/* Sessions header */}
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Sessions
                </h2>
                <Button
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={handleNewSession}
                  disabled={creating}
                >
                  {creating ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Plus className="size-3" />
                  )}
                  New Session
                </Button>
              </div>
            </div>
          </div>
          <div className="flex flex-col items-center justify-center flex-1 animate-[fade-up_400ms_ease-out_both]">
            <MessageSquare className="size-8 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No sessions yet.</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Start a new session to begin chatting with this agent.
            </p>
          </div>
        </div>

        <ConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          title="Delete session"
          description={`This will permanently delete "${deleteTarget?.title || "Untitled"}" and all its messages.`}
          loading={deleting}
          onConfirm={handleDeleteConversation}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto px-5">
        <div className="mx-auto max-w-2xl py-6">
          {/* Agent description */}
          {agent?.description && (
            <p className="text-base text-muted-foreground mb-6">
              {agent.description}
            </p>
          )}

          {/* Sessions header */}
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Sessions
            </h2>
            <Button
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={handleNewSession}
              disabled={creating}
            >
              {creating ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
              New Session
            </Button>
          </div>

          {/* Session rows */}
          <div className="space-y-2">
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    router.push(`/w/${slug}/agents/${agentId}/chat/${conv.id}`)
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      router.push(`/w/${slug}/agents/${agentId}/chat/${conv.id}`);
                    }
                  }}
                  className="group w-full text-left rounded-lg border border-border/50 bg-background/50 px-4 py-3 transition-colors duration-200 hover:bg-accent/50 cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">
                        {conv.title || (
                          <span className="text-muted-foreground">
                            Untitled &middot; {relativeTime(conv.created_at)}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatDate(conv.created_at)}
                        {conv.message_count !== undefined && (
                          <>
                            {" "}&middot;{" "}
                            {conv.message_count}{" "}
                            {conv.message_count === 1 ? "message" : "messages"}
                          </>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      title="Delete session"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(conv);
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 p-1 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Delete session confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete session"
        description={`This will permanently delete "${deleteTarget?.title || "Untitled"}" and all its messages.`}
        loading={deleting}
        onConfirm={handleDeleteConversation}
      />
    </>
  );
}
