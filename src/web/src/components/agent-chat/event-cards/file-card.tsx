import React from "react";
import { formatSize } from "@/components/agent-chat/artifact-sheet";

function getExtension(filename: string, contentType?: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot > -1) return filename.slice(dot + 1).toUpperCase();
  if (contentType) {
    const sub = contentType.split("/")[1];
    if (sub) return sub.split(";")[0].toUpperCase();
  }
  return "FILE";
}

export function FileCard({
  filename,
  size,
  contentType,
  version,
  hasDuplicates,
  onClick,
}: {
  filename: string;
  size: number;
  contentType?: string;
  version?: number;
  hasDuplicates?: boolean;
  onClick?: () => void;
}) {
  const ext = getExtension(filename, contentType);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="card-grain w-104 max-w-full overflow-hidden rounded-(--radius) border border-(--border) bg-(--paper) text-left grid grid-cols-[44px_1fr] cursor-pointer [transition:translate_.2s_cubic-bezier(.2,.8,.2,1),box-shadow_.2s_ease] hover:-translate-y-0.5 [box-shadow:var(--e1)] hover:[box-shadow:var(--e2)]"
    >
      <span className="flex flex-col items-center justify-center border-r border-(--border) bg-[oklch(from_var(--tf)_l_c_h/0.08)] gap-1 p-2">
        <span className="flex flex-col gap-1 w-4.5">
          <i className="h-[1.5px] rounded-sm bg-(--tf) opacity-[0.28] w-full" />
          <i className="h-[1.5px] rounded-sm bg-(--tf) opacity-[0.28] w-[78%]" />
          <i className="h-[1.5px] rounded-sm bg-(--tf) opacity-[0.28] w-[55%]" />
        </span>
        <span className="font-mono text-[0.44rem] font-semibold uppercase text-(--tf) mt-px tracking-[0.02em]">
          {ext}
        </span>
      </span>
      <span className="p-3 min-w-0 flex flex-col justify-center gap-1">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-[0.9rem] font-semibold tracking-[-0.01em] truncate">
            {filename}
          </span>
          {hasDuplicates && version != null && (
            <span className="shrink-0 text-xs text-(--muted-foreground) bg-(--muted) rounded-full px-2 py-1 font-normal">
              v{version}
            </span>
          )}
        </span>
        <span className="text-[0.7rem] text-(--muted-foreground) font-mono">
          {formatSize(size)}
        </span>
      </span>
    </button>
  );
}
