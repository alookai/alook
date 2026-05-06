"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/contexts/workspace-context";
import { getMemberMe, updateMemberMe } from "@/lib/api";
import { MarkdownEditor } from "@/components/ui/markdown-editor";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const MAX_LENGTH = 50_000;
const DEBOUNCE_MS = 500;

function UsageRing({ ratio, size = 16, stroke = 1.5 }: { ratio: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const visual = ratio <= 0 ? 0 : ratio >= 1 ? 1 : Math.log1p(ratio * 99) / Math.log(100);
  const filled = visual * circ;
  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-border" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeDasharray={`${filled} ${circ - filled}`}
        strokeLinecap="round"
        className={cn(
          "transition-all duration-300",
          ratio > 0.9 ? "text-destructive/70" : ratio > 0.7 ? "text-yellow-500/50" : "text-muted-foreground/30"
        )}
      />
    </svg>
  );
}

export function InstructionTab() {
  const { workspaceId } = useWorkspace();
  const [value, setValue] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [loading, setLoading] = useState(true);

  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const savedValueRef = useRef(savedValue);
  useEffect(() => {
    savedValueRef.current = savedValue;
  }, [savedValue]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);

  const fetchInstruction = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getMemberMe(workspaceId);
      setValue(data.global_instruction);
      setSavedValue(data.global_instruction);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchInstruction();
  }, [fetchInstruction]);

  const flushSave = useCallback(async () => {
    if (savingRef.current) return;
    const current = valueRef.current;
    if (current === savedValueRef.current) return;
    savingRef.current = true;
    try {
      const data = await updateMemberMe(workspaceId, current);
      setSavedValue(data.global_instruction);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      savingRef.current = false;
    }
  }, [workspaceId]);

  const scheduleSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(flushSave, DEBOUNCE_MS);
  }, [flushSave]);

  const handleChange = useCallback(
    (next: string) => {
      setValue(next);
      scheduleSave();
    },
    [scheduleSave],
  );

  useEffect(() => {
    const onBeforeUnload = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (valueRef.current !== savedValueRef.current) {
        const params = new URLSearchParams({ workspace_id: workspaceId });
        fetch(`/api/members/me?${params}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ global_instruction: valueRef.current }),
          keepalive: true,
        });
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [workspaceId]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (valueRef.current !== savedValueRef.current) {
        void flushSave();
      }
    };
  }, [flushSave]);

  const ratio = value.length / MAX_LENGTH;

  if (loading) {
    return (
      <div className="px-6 py-6 space-y-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 px-6 pt-4 pb-4">
        <MarkdownEditor
          value={value}
          onChange={handleChange}
          placeholder="Write instructions that every agent you own will follow..."
          minHeight="calc(100vh - 240px)"
          contentType="markdown"
          variant="seamless"
        />
      </div>
      <div className="flex items-center gap-2 px-6 py-3">
        <UsageRing ratio={ratio} />
        <p className="text-xs text-muted-foreground">
          This instruction is prepended to every agent&apos;s individual instruction.
        </p>
      </div>
    </div>
  );
}
