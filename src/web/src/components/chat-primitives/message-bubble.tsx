import type { ReactNode, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type BubbleVariant = "agent" | "user";
export type BubblePosition = "first" | "middle" | "last" | "single";

interface MessageBubbleProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  variant: BubbleVariant;
  position: BubblePosition;
  children: ReactNode;
  className?: string;
}

const USER_RADIUS: Record<BubblePosition, string> = {
  single: "rounded-[1.05rem]",
  first: "rounded-[1.05rem] rounded-br-[0.35rem]",
  middle: "rounded-[1.05rem] rounded-tr-[0.35rem] rounded-br-[0.35rem]",
  last: "rounded-[1.05rem] rounded-tr-[0.35rem]",
};

const AGENT_RADIUS: Record<BubblePosition, string> = {
  single: "rounded-[1.05rem]",
  first: "rounded-[1.05rem] rounded-bl-[0.35rem]",
  middle: "rounded-[1.05rem] rounded-tl-[0.35rem] rounded-bl-[0.35rem]",
  last: "rounded-[1.05rem] rounded-tl-[0.35rem]",
};

export function MessageBubble({
  variant,
  position,
  children,
  className,
  ...rest
}: MessageBubbleProps) {
  const radius =
    variant === "user" ? USER_RADIUS[position] : AGENT_RADIUS[position];
  const colors =
    variant === "user"
      ? "bg-primary text-primary-foreground"
      : "bg-muted text-foreground";

  return (
    <div
      className={cn(
        "px-3 py-2 text-base",
        radius,
        colors,
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
