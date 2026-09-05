"use client";

import { GeneratedAvatar } from "./generated-avatar";
import { resolveAvatar } from "@/lib/avatar/resolve";
import { cn } from "@/lib/utils";
import { RemoteIdentityImage } from "@/components/remote-image";

interface AgentAvatarProps {
  name?: string | null;
  avatarUrl?: string | null;
  seed?: string | null;
  size?: number;
  className?: string;
  alt?: string;
}

export function AgentAvatar({ name, avatarUrl, seed, size = 32, className, alt }: AgentAvatarProps) {
  // Prefer a stable id as the beam seed; fall back to the name when no id is
  // available (rename would then shift the face — a known tradeoff).
  const resolved = resolveAvatar(avatarUrl, seed || name || "?");
  const avatarClassName = cn("shrink-0 rounded-full", className);
  if (resolved.kind === "photo") {
    return (
      <span
        role={alt === "" ? undefined : "img"}
        aria-label={alt === "" ? undefined : alt ?? name ?? undefined}
        aria-hidden={alt === "" ? true : undefined}
        className={cn("relative block overflow-hidden", avatarClassName)}
        style={{ width: size, height: size }}
      >
        <RemoteIdentityImage
          src={resolved.url}
          alt=""
          className="rounded-[inherit]"
          placeholderClassName="rounded-[inherit]"
        />
      </span>
    );
  }
  return <GeneratedAvatar seed={resolved.seed} size={size} className={avatarClassName} />;
}
