"use client";

import { GeneratedAvatar } from "./generated-avatar";
import { resolveAvatar } from "@/lib/avatar/resolve";
import { cn } from "@/lib/utils";

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
      <img
        src={resolved.url}
        alt={alt ?? name ?? ""}
        className={cn("object-cover", avatarClassName)}
        style={{ width: size, height: size }}
      />
    );
  }
  return <GeneratedAvatar seed={resolved.seed} size={size} className={avatarClassName} />;
}
