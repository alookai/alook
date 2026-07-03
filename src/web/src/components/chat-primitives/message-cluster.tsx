import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ClusterPosition = "first" | "middle" | "last" | "solo";

export interface MessageClusterProps {
  avatar: ReactNode;
  name: string;
  children: ReactNode;
  position: ClusterPosition;
  className?: string;
}

const AVATAR_SIZE = 30;
const GUTTER_W = "w-[30px]";

export function MessageCluster({
  avatar,
  name,
  children,
  position,
  className,
}: MessageClusterProps) {
  const isClusterHead = position === "first" || position === "solo";

  return (
    <div className={cn("flex justify-start items-start gap-2 min-w-0", className)}>
      <div className={cn(GUTTER_W, "shrink-0")} aria-hidden={!isClusterHead}>
        {isClusterHead && avatar}
      </div>
      <div className="min-w-0 max-w-[86%] flex flex-col items-start gap-1">
        {isClusterHead && (
          <span className="text-[0.85rem] font-semibold text-foreground leading-[1.15] pt-0.5 mb-1">
            {name}
          </span>
        )}
        {children}
      </div>
    </div>
  );
}

export { AVATAR_SIZE };
