"use client";

import { BoringAvatar } from "./boring-avatar";
import { resolveAvatar } from "@/lib/avatar/resolve";

export function AgentAvatar({ name, avatarUrl, seed, size = 32 }: { name?: string | null; avatarUrl?: string | null; seed?: string | null; size?: number }) {
  // Prefer a stable id as the beam seed; fall back to the name when no id is
  // available (rename would then shift the face — a known tradeoff).
  const resolved = resolveAvatar(avatarUrl, seed || name || "?");
  if (resolved.kind === "photo") {
    return (
      <img
        src={resolved.url}
        alt={name ?? ""}
        className="rounded-full shrink-0 object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return <BoringAvatar seed={resolved.seed} size={size} className="rounded-full shrink-0" />;
}
