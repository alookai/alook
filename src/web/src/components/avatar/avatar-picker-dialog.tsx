"use client";

import { useState } from "react";
import { Shuffle } from "lucide-react";
import { GeneratedAvatar } from "./generated-avatar";
import { serializeBeamSeed, parseBeamSeed } from "@/lib/avatar/seed-url";

interface AvatarPickerDialogProps {
  /** Stored avatar value (`avatar:beam:{seed}` or a photo URL). */
  value: string | null;
  /** Emits the new stored value (`avatar:beam:{seed}`). */
  onChange: (value: string) => void;
}

function randomSeed(): string {
  return crypto.randomUUID();
}

/**
 * Generated avatar picker: a preview and Shuffle control that rerolls the stored seed.
 */
export function AvatarPickerDialog({ value, onChange }: AvatarPickerDialogProps) {
  const [seed, setSeed] = useState<string>(() => parseBeamSeed(value) ?? randomSeed());

  const shuffle = () => {
    const next = randomSeed();
    setSeed(next);
    onChange(serializeBeamSeed(next));
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="rounded-2xl bg-background p-2 shadow-sm border border-border">
        <span className="block size-20 overflow-hidden rounded-2xl">
          <GeneratedAvatar seed={seed} size={80} className="size-full" />
        </span>
      </div>
      <button
        type="button"
        onClick={shuffle}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent transition-colors cursor-pointer"
      >
        <Shuffle className="size-3.5" />
        Shuffle
      </button>
    </div>
  );
}
