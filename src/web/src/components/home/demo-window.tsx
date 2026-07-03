import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function DemoWindow({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/60 bg-background shadow-lg overflow-hidden flex flex-col dark",
        className,
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-muted/30 shrink-0">
        <span className="size-2.5 rounded-full bg-red-400/80" />
        <span className="size-2.5 rounded-full bg-yellow-400/80" />
        <span className="size-2.5 rounded-full bg-green-400/80" />
        {title && (
          <span className="ml-2 text-[11px] text-muted-foreground font-medium">
            {title}
          </span>
        )}
      </div>
      <div className="relative flex-1 min-h-0">{children}</div>
    </div>
  );
}
