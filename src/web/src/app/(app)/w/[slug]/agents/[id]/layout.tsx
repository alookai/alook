"use client";

import { useState, useEffect, type ReactNode } from "react";
import { useParams, useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AgentEditForm } from "@/components/agent-edit-form";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentStatusBadge } from "@/components/agent-status-badge";
import { CalendarDays, Mail, MessageSquare, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { MobileSidebarLogo } from "@/components/mobile-sidebar-logo";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { fetchModelOptions } from "@/lib/api";

export default function AgentDetailLayout({ children }: { children: ReactNode }) {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const { slug } = useWorkspace();
  const agentId = params.id as string;
  const isOnEmail = pathname.includes(`/agents/${agentId}/email`);
  const { agents, runtimes, handleDeleteAgent, handleUpdateAgent } = useAgentContext();

  const agent = agents.find((a) => a.id === agentId);
  const runtime = agent ? runtimes.find((r) => r.id === agent.runtime_id) : null;
  const isOnline = runtime?.status === "online";
  const { activeTaskCounts } = useAgentContext();
  const taskCount = activeTaskCounts[agentId] ?? 0;

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [agentConfirmOpen, setAgentConfirmOpen] = useState(false);
  const [agentDeleting, setAgentDeleting] = useState(false);
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});

  useEffect(() => {
    fetchModelOptions().then(setModelOptions).catch(() => {});
  }, []);

  return (
    <>
      {/* Top navbar */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 md:px-5 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <MobileSidebarLogo />
          {agent ? (
            <AgentStatusBadge
              isOnline={isOnline}
              taskCount={taskCount}
              agentId={agentId}
            />
          ) : (
            <Skeleton className="size-2 rounded-full shrink-0" />
          )}
          {agent ? (
            <Link
              href={`/w/${slug}/agents/${agentId}`}
              onClick={() => setEditing(false)}
              className="text-sm font-medium truncate hover:text-foreground/80 transition-colors"
            >
              <span title={agent.description || "No description"}>
                {agent.name}
              </span>
            </Link>
          ) : (
            <Skeleton className="h-3.5 w-24" />
          )}
          <span className="text-xs text-muted-foreground">
            / {editing ? "Settings" : isOnEmail ? "Email" : "Chat"}
          </span>
        </div>
        {agent ? (
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
                {/* Desktop: inline buttons */}
                <div className="hidden sm:flex items-center gap-0.5">
                  {isOnEmail ? (
                    <Link
                      href={`/w/${slug}/agents/${agentId}`}
                      className="inline-flex items-center rounded-lg text-xs text-muted-foreground h-7 gap-1 px-2 hover:bg-muted hover:text-foreground transition-all"
                    >
                      <MessageSquare className="size-3" />
                      Chat
                    </Link>
                  ) : (
                    <Link
                      href={`/w/${slug}/agents/${agentId}/email`}
                      className="inline-flex items-center rounded-lg text-xs text-muted-foreground h-7 gap-1 px-2 hover:bg-muted hover:text-foreground transition-all"
                    >
                      <Mail className="size-3" />
                      Email
                    </Link>
                  )}
                  <Link
                    href={`/w/${slug}/calendar?agents=${agentId}`}
                    className="inline-flex items-center rounded-lg text-xs text-muted-foreground h-7 gap-1 px-2 hover:bg-muted hover:text-foreground transition-all"
                  >
                    <CalendarDays className="size-3" />
                    Calendar
                  </Link>
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
                </div>

                {/* Mobile: collapsed dropdown */}
                <div className="sm:hidden">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" sideOffset={6}>
                      <DropdownMenuItem
                        onClick={() =>
                          router.push(
                            isOnEmail
                              ? `/w/${slug}/agents/${agentId}`
                              : `/w/${slug}/agents/${agentId}/email`
                          )
                        }
                      >
                        {isOnEmail ? (
                          <><MessageSquare className="size-3.5" /> Chat</>
                        ) : (
                          <><Mail className="size-3.5" /> Email</>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          router.push(`/w/${slug}/calendar?agents=${agentId}`)
                        }
                      >
                        <CalendarDays className="size-3.5" />
                        Calendar
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setEditing(true)}>
                        <Pencil className="size-3.5" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setAgentConfirmOpen(true)}
                      >
                        <Trash2 className="size-3.5" />
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="h-7 shrink-0" />
        )}
      </div>

      {/* Content: edit form OR full-width children */}
      {editing && agent ? (
        <AgentEditForm
          agent={agent}
          runtimes={runtimes}
          modelOptions={modelOptions}
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
