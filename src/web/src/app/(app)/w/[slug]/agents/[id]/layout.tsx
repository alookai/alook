"use client";

import { useState, useEffect, type ReactNode } from "react";
import { useParams, useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AgentEditForm } from "@/components/agent-edit-form";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentStatusBadge } from "@/components/agent-status-badge";
import { CalendarDays, History, Mail, MessageSquare, MoreHorizontal, Pencil, Trash2, Video, X } from "lucide-react";
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
  const searchParams = useSearchParams();
  const agentId = params.id as string;
  const isActivityView = !!searchParams.get("conv");
  const currentTab = pathname.includes("/activity") || isActivityView
    ? "activity"
    : pathname.includes("/meetings")
      ? "meetings"
      : pathname.includes("/email")
        ? "email"
        : "chat";
  const tabLabels: Record<string, string> = { email: "Email", meetings: "Meetings", activity: "Activity" };
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
            / {editing ? "Settings" : tabLabels[currentTab] ?? "Chat"}
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
                  <Link
                    href={`/w/${slug}/agents/${agentId}`}
                    className={`group inline-flex items-center rounded-lg text-xs h-7 px-2 transition-all ${
                      currentTab === "chat"
                        ? "text-foreground bg-muted"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <MessageSquare className="size-3 shrink-0" />
                    <span className={`overflow-hidden transition-all duration-500 ease-out ${
                      currentTab === "chat"
                        ? "max-w-16 opacity-100 ml-1"
                        : "max-w-0 opacity-0 group-hover:max-w-16 group-hover:opacity-100 group-hover:ml-1 group-hover:delay-300"
                    }`}>Chat</span>
                  </Link>
                  <Link
                    href={`/w/${slug}/agents/${agentId}/email`}
                    className={`group inline-flex items-center rounded-lg text-xs h-7 px-2 transition-all ${
                      currentTab === "email"
                        ? "text-foreground bg-muted"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <Mail className="size-3 shrink-0" />
                    <span className={`overflow-hidden transition-all duration-500 ease-out ${
                      currentTab === "email"
                        ? "max-w-16 opacity-100 ml-1"
                        : "max-w-0 opacity-0 group-hover:max-w-16 group-hover:opacity-100 group-hover:ml-1 group-hover:delay-300"
                    }`}>Email</span>
                  </Link>
                  <Link
                    href={`/w/${slug}/agents/${agentId}/meetings`}
                    className={`group inline-flex items-center rounded-lg text-xs h-7 px-2 transition-all ${
                      currentTab === "meetings"
                        ? "text-foreground bg-muted"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <Video className="size-3 shrink-0" />
                    <span className={`overflow-hidden transition-all duration-500 ease-out ${
                      currentTab === "meetings"
                        ? "max-w-20 opacity-100 ml-1"
                        : "max-w-0 opacity-0 group-hover:max-w-20 group-hover:opacity-100 group-hover:ml-1 group-hover:delay-300"
                    }`}>Meetings</span>
                  </Link>
                  <Link
                    href={`/w/${slug}/agents/${agentId}/activity`}
                    className={`group inline-flex items-center rounded-lg text-xs h-7 px-2 transition-all ${
                      currentTab === "activity"
                        ? "text-foreground bg-muted"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <History className="size-3 shrink-0" />
                    <span className={`overflow-hidden transition-all duration-500 ease-out ${
                      currentTab === "activity"
                        ? "max-w-16 opacity-100 ml-1"
                        : "max-w-0 opacity-0 group-hover:max-w-16 group-hover:opacity-100 group-hover:ml-1 group-hover:delay-300"
                    }`}>Activity</span>
                  </Link>
                  <Link
                    href={`/w/${slug}/calendar?agents=${agentId}`}
                    className="group inline-flex items-center rounded-lg text-xs text-muted-foreground h-7 px-2 hover:bg-muted hover:text-foreground transition-all"
                  >
                    <CalendarDays className="size-3 shrink-0" />
                    <span className="max-w-0 opacity-0 group-hover:max-w-20 group-hover:opacity-100 group-hover:ml-1 group-hover:delay-300 overflow-hidden transition-all duration-500 ease-out">Calendar</span>
                  </Link>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="group text-xs text-muted-foreground h-7 px-2"
                    onClick={() => setEditing(true)}
                  >
                    <Pencil className="size-3 shrink-0" />
                    <span className="max-w-0 opacity-0 group-hover:max-w-12 group-hover:opacity-100 group-hover:ml-1 group-hover:delay-300 overflow-hidden transition-all duration-500 ease-out">Edit</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="group text-xs text-muted-foreground h-7 px-2 hover:text-destructive"
                    onClick={() => setAgentConfirmOpen(true)}
                  >
                    <Trash2 className="size-3 shrink-0" />
                    <span className="max-w-0 opacity-0 group-hover:max-w-16 group-hover:opacity-100 group-hover:ml-1 group-hover:delay-300 overflow-hidden transition-all duration-500 ease-out">Remove</span>
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
                      {currentTab !== "chat" && (
                        <DropdownMenuItem
                          onClick={() => router.push(`/w/${slug}/agents/${agentId}`)}
                        >
                          <MessageSquare className="size-3.5" /> Chat
                        </DropdownMenuItem>
                      )}
                      {currentTab !== "email" && (
                        <DropdownMenuItem
                          onClick={() => router.push(`/w/${slug}/agents/${agentId}/email`)}
                        >
                          <Mail className="size-3.5" /> Email
                        </DropdownMenuItem>
                      )}
                      {currentTab !== "meetings" && (
                        <DropdownMenuItem
                          onClick={() => router.push(`/w/${slug}/agents/${agentId}/meetings`)}
                        >
                          <Video className="size-3.5" /> Meetings
                        </DropdownMenuItem>
                      )}
                      {currentTab !== "activity" && (
                        <DropdownMenuItem
                          onClick={() => router.push(`/w/${slug}/agents/${agentId}/activity`)}
                        >
                          <History className="size-3.5" /> Activity
                        </DropdownMenuItem>
                      )}
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
