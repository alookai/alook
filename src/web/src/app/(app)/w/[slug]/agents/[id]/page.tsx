"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { listAgentConversations, deleteConversation } from "@/lib/api";
import type { Conversation } from "@alook/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AgentEditForm } from "@/components/agent-edit-form";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Plus, Loader2, Trash2, Pencil, X } from "lucide-react";

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

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { slug, workspaceId } = useWorkspace();
  const agentId = params.id as string;
  const {
    agents,
    runtimes,
    chatWithAgent,
    handleDeleteAgent,
    handleUpdateAgent,
  } = useAgentContext();

  const agent = agents.find((a) => a.id === agentId);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Delete conversation state
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Delete agent state
  const [agentConfirmOpen, setAgentConfirmOpen] = useState(false);
  const [agentDeleting, setAgentDeleting] = useState(false);

  // Inline edit state
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

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
        router.push(`/w/${slug}/chat/${conversationId}?agent=${agentId}`);
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

  const runtime = agent
    ? runtimes.find((r) => r.id === agent.runtime_id)
    : null;
  const isOnline = runtime?.status === "online";

  return (
    <>
      {/* Navbar — same pattern as chat page */}
      <div className="flex items-center justify-between border-b border-border/50 px-5 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          {agent && (
            <span
              title={isOnline ? "Runtime online" : "Runtime offline"}
              className={cn(
                "size-2 rounded-full shrink-0",
                isOnline ? "bg-status-online" : "bg-status-offline"
              )}
            />
          )}
          <h1 className="text-sm font-medium truncate">
            {agent?.name || "Agent"}
          </h1>
          {editing && (
            <span className="text-xs text-muted-foreground">/ Settings</span>
          )}
        </div>
        {agent && (
          <div className="flex items-center gap-0.5 shrink-0">
            {editing ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground h-7 gap-1 px-2"
                onClick={() => setEditing(false)}
              >
                <X className="size-3" />
                Cancel
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground h-7 gap-1 px-2"
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="size-3" />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground h-7 px-2 hover:text-destructive"
                  onClick={() => setAgentConfirmOpen(true)}
                >
                  <Trash2 className="size-3" />
                  Remove
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {editing && agent ? (
        <AgentEditForm
          agent={agent}
          runtimes={runtimes}
          saving={saving}
          onCancel={() => setEditing(false)}
          onSave={async (data) => {
            setSaving(true);
            try {
              const ok = await handleUpdateAgent(agent.id, data);
              if (ok) setEditing(false);
              return ok;
            } finally {
              setSaving(false);
            }
          }}
        />
      ) : (
        /* Session list */
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

            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : conversations.length === 0 ? (
              /* Empty state */
              <div className="text-center py-20 animate-[fade-up_400ms_ease-out_both]">
                <p className="text-sm text-muted-foreground">
                  No sessions yet.
                </p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  Start a new session to begin chatting with this agent.
                </p>
              </div>
            ) : (
              /* Session rows */
              <div className="space-y-2">
                {conversations.map((conv) => (
                  <div
                    key={conv.id}
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      router.push(`/w/${slug}/chat/${conv.id}?agent=${agentId}`)
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        router.push(`/w/${slug}/chat/${conv.id}?agent=${agentId}`);
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
            )}
          </div>
        </div>
      )}

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

      {/* Delete agent confirmation */}
      {agent && (
        <ConfirmDialog
          open={agentConfirmOpen}
          onOpenChange={setAgentConfirmOpen}
          title="Remove agent"
          description={`This will permanently delete "${agent.name}" and all its conversations.`}
          loading={agentDeleting}
          onConfirm={async () => {
            setAgentDeleting(true);
            try {
              const ok = await handleDeleteAgent(agent.id);
              if (ok) router.push(`/w/${slug}/home`);
            } finally {
              setAgentDeleting(false);
              setAgentConfirmOpen(false);
            }
          }}
        />
      )}
    </>
  );
}
