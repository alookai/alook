"use client";

import { useState, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AgentEditForm } from "@/components/agent-edit-form";
import { cn } from "@/lib/utils";
import { MessageSquare, Pencil, Trash2, X } from "lucide-react";

export default function AgentDetailLayout({ children }: { children: ReactNode }) {
  const params = useParams();
  const router = useRouter();
  const { slug } = useWorkspace();
  const agentId = params.id as string;
  const { agents, runtimes, handleDeleteAgent, handleUpdateAgent } = useAgentContext();

  const agent = agents.find((a) => a.id === agentId);
  const runtime = agent ? runtimes.find((r) => r.id === agent.runtime_id) : null;
  const isOnline = runtime?.status === "online";

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [agentConfirmOpen, setAgentConfirmOpen] = useState(false);
  const [agentDeleting, setAgentDeleting] = useState(false);

  return (
    <>
      {/* Top navbar */}
      <div className="flex items-center justify-between border-b border-border/50 px-5 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          {agent && (
            <Link
              href={`/w/${slug}/runtimes`}
              title={isOnline ? "Runtime online" : "Runtime offline"}
            >
              <span
                className={cn(
                  "size-2 rounded-full shrink-0 block",
                  isOnline ? "bg-status-online" : "bg-status-offline"
                )}
              />
            </Link>
          )}
          <Link
            href={`/w/${slug}/agents/${agentId}/email`}
            onClick={() => setEditing(false)}
            className="text-sm font-medium truncate hover:text-foreground/80 transition-colors"
          >
            {agent?.name || "Agent"}
          </Link>
          {editing && <span className="text-xs text-muted-foreground">/ Settings</span>}
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
                  asChild
                >
                  <Link href={`/w/${slug}/agents/${agentId}/chat`}>
                    <MessageSquare className="size-3" />
                    Chat
                  </Link>
                </Button>
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

      {/* Content: edit form OR full-width children */}
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
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{children}</div>
      )}

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
