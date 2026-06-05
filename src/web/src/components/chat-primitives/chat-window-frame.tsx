import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ChatWindowFrameProps {
  title: string;
  children: ReactNode;
  className?: string;
}

export function ChatWindowFrame({
  title,
  children,
  className,
}: ChatWindowFrameProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-background shadow-lg",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="size-3 rounded-full bg-[#FF5F57]" />
          <span className="size-3 rounded-full bg-[#FEBC2E]" />
          <span className="size-3 rounded-full bg-[#28C840]" />
        </div>
        <span className="flex-1 text-center text-sm font-medium text-muted-foreground">
          {title}
        </span>
        <div className="w-13" />
      </div>
      <div>{children}</div>
    </div>
  );
}
