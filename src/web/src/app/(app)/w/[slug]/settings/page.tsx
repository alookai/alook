"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/contexts/workspace-context";
import { getMemberMe, updateMemberMe } from "@/lib/api";
import { MobileSidebarLogo } from "@/components/mobile-sidebar-logo";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

const MAX_LENGTH = 50_000;

export default function SettingsPage() {
  const { workspaceId } = useWorkspace();
  const [value, setValue] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await updateMemberMe(workspaceId, value);
      setSavedValue(data.global_instruction);
      toast.success("Settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const isDirty = value !== savedValue;

  return (
    <>
      <div className="flex items-center justify-between border-b border-border/50 px-3 md:px-5 py-2.5 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <MobileSidebarLogo />
          <h1 className="text-sm font-medium">Settings</h1>
          <p className="text-xs text-muted-foreground hidden md:block">
            Instructions shared across all your agents
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {loading ? (
          <div className="mx-auto max-w-md space-y-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="mx-auto max-w-md space-y-4">
            <Label htmlFor="global-instruction">Global Instruction</Label>
            <Textarea
              id="global-instruction"
              rows={10}
              className="min-h-16"
              placeholder="Write instructions that every agent you own will follow..."
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={MAX_LENGTH}
            />
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground/70">
                This markdown instruction is prepended to every agent&apos;s individual instruction.
              </p>
              <span className="text-xs text-muted-foreground tabular-nums shrink-0 ml-4">
                {value.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
              </span>
            </div>
            <div className="flex items-center gap-2 pt-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!isDirty || saving}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
