"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetBody,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { X, Mail, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getEmail, getEmailBody } from "@/lib/api";
import { EmailBodyFrame } from "@/components/email-body-frame";
import type { Email } from "@alook/shared";

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
  const [email, setEmail] = useState<Email | null>(null);
  const [body, setBody] = useState<{ content: string; isHtml: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragging = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; });

  useEffect(() => {
    if (!open || !emailId) return;
    setLoading(true);
    setEmail(null);
    setBody(null);

    Promise.all([
      getEmail(emailId, workspaceId),
      getEmailBody(emailId, workspaceId),
    ])
      .then(([emailData, bodyData]) => {
        setEmail(emailData);
        setBody(bodyData);
      })
      .catch(() => {
        toast.error("Email not found");
        onOpenChangeRef.current(false);
      })
      .finally(() => setLoading(false));
  }, [open, emailId, workspaceId]);

  const handleOpenChange = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      setTimeout(() => {
        setEmail(null);
        setBody(null);
      }, 300);
    }
  };

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const maxW = window.innerWidth * MAX_WIDTH_RATIO;
    setWidth(Math.min(maxW, Math.max(MIN_WIDTH, window.innerWidth - e.clientX)));
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        style={{ width: `min(${width}px, 100vw)`, maxWidth: "none" }}
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border"
      >
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="hidden sm:block absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 hover:bg-primary/20 active:bg-primary/30 transition-colors rounded-l-xl"
        />
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
                  <p className="text-xs text-muted-foreground mb-2">
                    {email.attachments.length} attachment{email.attachments.length > 1 ? "s" : ""}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {email.attachments.map((att) => (
                      <span key={att.key} className="inline-flex items-center gap-1 text-xs bg-muted rounded px-2 py-1">
                        {att.filename}
                      </span>
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
