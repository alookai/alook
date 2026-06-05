import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ComposerShellProps {
  placeholder?: string;
  disabled?: boolean;
  children?: ReactNode;
  className?: string;
}

export function ComposerShell({
  placeholder,
  disabled,
  children,
  className,
}: ComposerShellProps) {
  return (
    <div
      className={cn(
        "relative flex-1 min-w-0 flex flex-col rounded-3xl border border-border/50 bg-background/90",
        "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        disabled && "opacity-50",
        className,
      )}
    >
      <div className="px-13 py-3">
        {children ?? (
          <p className="text-base text-muted-foreground/60 select-none">
            {placeholder}
          </p>
        )}
      </div>
    </div>
  );
}
