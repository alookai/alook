"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useWorkspace } from "@/contexts/workspace-context";
import { useAgentContext } from "@/contexts/agent-context";
import { listEmails, getEmailBody } from "@/lib/api";
import type { Email } from "@alook/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Loader2, Mail } from "lucide-react";

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
  const agentId = params.id as string;
  const { workspaceId } = useWorkspace();
  const { subscribeWs } = useAgentContext();

  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);

  const selected = emails.find((e) => e.id === selectedId) ?? null;

  const loadEmails = useCallback(async () => {
    try {
      const data = await listEmails(agentId, workspaceId);
      setEmails(data);
    } catch {
      toast.error("Failed to load emails");
    } finally {
      setLoading(false);
    }
  }, [agentId, workspaceId]);

  useEffect(() => {
    loadEmails();
  }, [loadEmails]);

  // Re-fetch when a new email arrives for this agent
  useEffect(() => {
    return subscribeWs((msg) => {
      if (msg.type === "email.received" && msg.agentId === agentId) {
        loadEmails();
      }
    });
  }, [subscribeWs, agentId, loadEmails]);

  const handleSelect = async (emailId: string) => {
    setSelectedId(emailId);
    setBody(null);
    setBodyLoading(true);
    try {
      const text = await getEmailBody(emailId, workspaceId);
      setBody(text);
    } catch {
      setBody("(body not available)");
    } finally {
      setBodyLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (emails.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 animate-[fade-up_400ms_ease-out_both]">
        <Mail className="size-8 text-muted-foreground/40 mb-3" />
        <p className="text-sm text-muted-foreground">No emails yet.</p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          Emails sent to this agent will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* Email list panel */}
      <div className="w-2/5 min-w-[240px] max-w-[400px] border-r border-border/40 overflow-y-auto">
        {emails.map((email) => (
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
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <p className="text-sm font-medium truncate">
                {email.from_email}
              </p>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {relativeTime(email.created_at)}
              </span>
            </div>
            <p className="text-sm truncate">
              {email.subject || "(no subject)"}
            </p>
            <div className="mt-1">
              {email.is_whitelisted ? (
                <Badge className="text-[10px] h-4 px-1">triggered</Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px] h-4 px-1">
                  forwarded
                </Badge>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* Email detail panel */}
      <div className="flex-1 overflow-y-auto">
        {!selected ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select an email to view
          </div>
        ) : (
          <div className="p-5 max-w-2xl">
            <h2 className="text-lg font-medium mb-1">
              {selected.subject || "(no subject)"}
            </h2>
            <div className="flex items-center gap-2 mb-4">
              {selected.is_whitelisted ? (
                <Badge className="text-[10px] h-4 px-1">triggered</Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px] h-4 px-1">
                  forwarded
                </Badge>
              )}
            </div>
            <div className="text-sm text-muted-foreground space-y-0.5 mb-5">
              <p>
                <span className="font-medium text-foreground">From:</span>{" "}
                {selected.from_email}
              </p>
              <p>
                <span className="font-medium text-foreground">To:</span>{" "}
                {selected.to_email}
              </p>
              <p>
                <span className="font-medium text-foreground">Received:</span>{" "}
                {new Date(selected.created_at).toLocaleString()}
              </p>
            </div>

            <div className="rounded-lg border border-border/50 bg-background/50 p-4">
              {bodyLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <pre className="text-sm whitespace-pre-wrap font-mono leading-relaxed">
                  {body}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
