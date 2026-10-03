"use client";

import { FileDownloadButton } from "@/components/file-download-button"
import { useEffect, useRef } from "react";
import { useSheetResize, SheetResizeHandle } from "@/components/ui/sheet-resize-handle";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetBody,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { X, Mail, Loader2, Paperclip, File as FileIcon } from "lucide-react";
import { toast } from "sonner";
import { getEmail, getEmailBody } from "@/lib/api";
import { EmailBodyFrame } from "@/components/email-body-frame";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceOwner } from "@/contexts/workspace-context";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { isAbortError } from "@/lib/errors";

interface EmailEventSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  emailId: string | null;
  workspaceId: string;
}

const MIN_WIDTH = 320;
const MAX_WIDTH_RATIO = 0.8;
const DEFAULT_WIDTH = 500;

export function EmailEventSheet({ open, onOpenChange, emailId, workspaceId }: EmailEventSheetProps) {
  const owner = useWorkspaceOwner();
  const source = useWorkspaceViewSource(owner, emailId ?? "__none__", open && !!emailId && workspaceId === owner.workspaceId);
  const emailQuery = useQuery({ queryKey: owner.key("emails", "detail", source.active ? emailId! : "__none__"), enabled: source.active,
    meta: { workspaceView: source.view },
    queryFn: ({ signal }) => getEmail(emailId!, owner.workspaceId, source.request(signal)),
  });
  const bodyQuery = useQuery({ queryKey: owner.key("emails", "body", source.active ? emailId! : "__none__"), enabled: source.active,
    meta: { workspaceView: source.view },
    queryFn: ({ signal }) => getEmailBody(emailId!, owner.workspaceId, source.request(signal)),
  });
  const email = emailQuery.data;
  const body = bodyQuery.data;
  const loading = source.active && (emailQuery.isPending || bodyQuery.isPending);
  const { width, onPointerDown, onPointerMove, onPointerUp } = useSheetResize({
    defaultWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
    maxWidthRatio: MAX_WIDTH_RATIO,
  });
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; });

  useEffect(() => {
    const error = emailQuery.error ?? bodyQuery.error;
    if (!error || emailQuery.isFetching || bodyQuery.isFetching || isAbortError(error)) return;
    try { source.assertActive(); } catch { return; }
    toast.error("Email not found");
    onOpenChangeRef.current(false);
  }, [emailQuery.error, bodyQuery.error, emailQuery.isFetching, bodyQuery.isFetching, source.assertActive, source]);
  const handleOpenChange = onOpenChange;


  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        style={{ width: `min(${width}px, 100vw)`, maxWidth: "none" }}
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border"
      >
        <SheetResizeHandle onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
        <SheetHeader>
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
            <SheetTitle className="truncate flex-1">
              {loading ? "Loading..." : email?.subject || "Email"}
            </SheetTitle>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleOpenChange(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </SheetHeader>

        <SheetBody className="flex-1 overflow-y-auto thin-scrollbar">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : email ? (
            <div className="flex flex-col gap-4">
              <div className="text-sm space-y-1 border-b pb-3">
                <div className="flex gap-2">
                  <span className="text-muted-foreground shrink-0">From:</span>
                  <span className="truncate">{email.from_email}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-muted-foreground shrink-0">To:</span>
                  <span className="truncate">{email.to_email}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-muted-foreground shrink-0">Date:</span>
                  <span>{new Date(email.created_at).toLocaleString()}</span>
                </div>
              </div>

              {body?.isHtml ? (
                <EmailBodyFrame html={body.content} className="max-w-full" />
              ) : (
                <pre className="whitespace-pre-wrap text-sm font-mono">{body?.content}</pre>
              )}

              {email.attachments && email.attachments.length > 0 && (
                <div className="border-t pt-3">
                  <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
                    <Paperclip className="size-3" />
                    {email.attachments.length} attachment{email.attachments.length > 1 ? "s" : ""}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {email.attachments.map((att, i) => (
                      <FileDownloadButton
                        key={att.key}
                        url={`/api/email/${email.id}/attachment/${i}?workspace_id=${workspaceId}`}
                        filename={att.filename}
                        className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/50 px-2 py-2 text-xs hover:bg-muted transition-colors cursor-pointer"
                      >
                        <FileIcon className="size-3 text-muted-foreground shrink-0" />
                        <span className="truncate max-w-45">{att.filename}</span>
                        <span className="text-muted-foreground shrink-0">
                          {att.size < 1024 ? `${att.size} B` : att.size < 1024 * 1024 ? `${(att.size / 1024).toFixed(1)} KB` : `${(att.size / (1024 * 1024)).toFixed(1)} MB`}
                        </span>
                      </FileDownloadButton>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
