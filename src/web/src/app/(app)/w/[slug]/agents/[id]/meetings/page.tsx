"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { useWorkspace } from "@/contexts/workspace-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetBody, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Video, Plus, Square, Check, Clock, AlertCircle, Loader2, Trash2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { listMeetings, createMeeting, stopMeeting, approveMeeting, deleteMeeting } from "@/lib/api";
import type { MeetingSession } from "@alook/shared";

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof Clock }> = {
  pending: { label: "Pending", variant: "outline", icon: Clock },
  scheduled: { label: "Scheduled", variant: "secondary", icon: Clock },
  joining: { label: "Joining...", variant: "default", icon: Loader2 },
  recording: { label: "Recording", variant: "default", icon: Video },
  completed: { label: "Completed", variant: "secondary", icon: Check },
  failed: { label: "Failed", variant: "destructive", icon: AlertCircle },
};

function MeetingStatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending!;
  const Icon = config.icon;
  return (
    <Badge variant={config.variant} className="gap-1 text-[10px]">
      <Icon className={cn("size-2.5", status === "joining" && "animate-spin", status === "recording" && "animate-pulse")} />
      {config.label}
    </Badge>
  );
}

function formatTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function AgentMeetingsPage() {
  const params = useParams();
  const agentId = params.id as string;
  const { workspaceId } = useWorkspace();

  const [meetings, setMeetings] = useState<MeetingSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MeetingSession | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Create form state
  const [meetUrl, setMeetUrl] = useState("");
  const [meetTitle, setMeetTitle] = useState("");
  const [meetParticipants, setMeetParticipants] = useState("");


  const loadMeetings = useCallback(async () => {
    try {
      const data = await listMeetings(agentId, workspaceId);
      setMeetings(data);
    } catch {
      toast.error("Failed to load meetings");
    } finally {
      setLoading(false);
    }
  }, [agentId, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    listMeetings(agentId, workspaceId)
      .then((data) => { if (!cancelled) { setMeetings(data); setLoading(false); } })
      .catch(() => { if (!cancelled) { toast.error("Failed to load meetings"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [agentId, workspaceId]);

  // Auto-refresh for active meetings
  useEffect(() => {
    const hasActive = meetings.some((m) => m.status === "joining" || m.status === "recording");
    if (!hasActive) return;
    const interval = setInterval(loadMeetings, 5000);
    return () => clearInterval(interval);
  }, [meetings, loadMeetings]);

  const handleCreate = async () => {
    if (!meetUrl) return;
    setCreating(true);
    try {
      const participants = meetParticipants
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      await createMeeting(agentId, workspaceId, {
        meetingUrl: meetUrl,
        title: meetTitle || undefined,
        participants: participants.length > 0 ? participants : undefined,
      });
      toast.success("Meeting created");
      setCreateOpen(false);
      setMeetUrl("");
      setMeetTitle("");
      setMeetParticipants("");
      loadMeetings();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create meeting");
    } finally {
      setCreating(false);
    }
  };

  const handleStop = async (meeting: MeetingSession) => {
    try {
      await stopMeeting(agentId, meeting.id, workspaceId);
      toast.success("Meeting stopped");
      loadMeetings();
    } catch {
      toast.error("Failed to stop meeting");
    }
  };

  const handleApprove = async (meeting: MeetingSession) => {
    try {
      await approveMeeting(agentId, meeting.id, workspaceId);
      toast.success("Meeting approved");
      loadMeetings();
    } catch {
      toast.error("Failed to approve meeting");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteMeeting(agentId, deleteTarget.id, workspaceId);
      toast.success("Meeting deleted");
      setDeleteTarget(null);
      loadMeetings();
    } catch {
      toast.error("Failed to delete meeting");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <h2 className="text-sm font-medium">Meetings</h2>
        <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1">
          <Plus className="size-3" />
          Join Meeting
        </Button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto thin-scrollbar">
        {loading ? (
          <div className="p-4 space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : meetings.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 p-8">
            <Video className="size-8 opacity-40" />
            <p className="text-sm">No meetings yet</p>
            <p className="text-xs">Join a Google Meet to start recording transcripts.</p>
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {meetings.map((meeting) => (
              <div
                key={meeting.id}
                className={cn(
                  "flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2 transition-colors",
                  meeting.status === "pending" && !meeting.is_whitelisted && "opacity-60",
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium truncate">
                      {meeting.title || "Untitled Meeting"}
                    </span>
                    <MeetingStatusBadge status={meeting.status} />
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{meeting.meeting_url.replace("https://", "")}</span>
                    {meeting.scheduled_at && (
                      <span className="shrink-0">{formatTime(meeting.scheduled_at)}</span>
                    )}
                    {meeting.started_at && !meeting.completed_at && (
                      <span className="shrink-0">Started {formatTime(meeting.started_at)}</span>
                    )}
                    {meeting.completed_at && (
                      <span className="shrink-0">{formatTime(meeting.completed_at)}</span>
                    )}
                    {(meeting.participants as string[])?.length > 0 && (
                      <span className="shrink-0">{(meeting.participants as string[]).length} participants</span>
                    )}
                  </div>
                  {meeting.error && (
                    <p className="text-xs text-destructive mt-1 truncate">{meeting.error}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {meeting.status === "pending" && (
                    <Button
                      variant="outline"
                      size="xs"
                      className="gap-1"
                      onClick={() => handleApprove(meeting)}
                    >
                      <ShieldCheck className="size-3" />
                      Approve
                    </Button>
                  )}
                  {(meeting.status === "recording" || meeting.status === "joining") && (
                    <Button
                      variant="outline"
                      size="xs"
                      className="gap-1 text-destructive"
                      onClick={() => handleStop(meeting)}
                    >
                      <Square className="size-3" />
                      Stop
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteTarget(meeting)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Meeting Sheet */}
      <Sheet open={createOpen} onOpenChange={setCreateOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Join a Meeting</SheetTitle>
          </SheetHeader>
          <SheetBody className="space-y-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Google Meet URL *
              </label>
              <input
                type="url"
                placeholder="https://meet.google.com/abc-defg-hij"
                value={meetUrl}
                onChange={(e) => setMeetUrl(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Title
              </label>
              <input
                type="text"
                placeholder="Weekly Standup"
                value={meetTitle}
                onChange={(e) => setMeetTitle(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Participants (one email per line)
              </label>
              <textarea
                placeholder={"alice@example.com\nbob@example.com"}
                value={meetParticipants}
                onChange={(e) => setMeetParticipants(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring resize-none"
              />
            </div>
          </SheetBody>
          <SheetFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || !meetUrl}>
              {creating && <Loader2 className="size-3 animate-spin" />}
              Join Meeting
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete meeting"
        description={`Remove "${deleteTarget?.title || "this meeting"}" and its transcript?`}
        loading={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}
