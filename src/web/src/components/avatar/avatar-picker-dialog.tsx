"use client";

import { useState } from "react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type AvatarConfig, AvatarRenderer } from "./avatar-parts";
import { AvatarGenerator } from "./avatar-generator";
import { useIsMobile } from "@/hooks/use-mobile";

interface AvatarPickerDialogProps {
  config: AvatarConfig;
  onChange: (config: AvatarConfig) => void;
}

export function AvatarPickerDialog({ config, onChange }: AvatarPickerDialogProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AvatarConfig>(config);
  const isMobile = useIsMobile();

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setDraft(config);
        setOpen(nextOpen);
      }}
    >
      <div className="flex justify-center">
        <DialogTrigger
          render={
            <button
              type="button"
              className="rounded-2xl bg-background p-2 shadow-sm border border-border hover:border-primary/40 transition-colors cursor-pointer"
            />
          }
        >
          <AvatarRenderer config={config} size={80} />
        </DialogTrigger>
      </div>

      <DialogContent className={
        isMobile
          ? "top-auto left-0 translate-x-0 translate-y-0 bottom-0 max-w-full sm:max-w-full w-full rounded-b-none rounded-t-xl max-h-[85dvh] overflow-y-auto pb-[env(safe-area-inset-bottom)]"
          : "sm:max-w-180"
      }>
        <DialogHeader>
          <DialogTitle>Choose Avatar</DialogTitle>
        </DialogHeader>
        <AvatarGenerator
          config={draft}
          layout={isMobile ? "vertical" : "horizontal"}
          onChange={(next) => {
            setDraft(next);
            onChange(next);
          }}
          mobile={isMobile}
        />
        {isMobile && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="w-full rounded-xl bg-primary py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Done
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}
