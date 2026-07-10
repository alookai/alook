"use client";

import { AvatarRenderer, parseAvatarUrl, isPhotoAvatarUrl } from "./avatar-parts";

export function AgentAvatar({ name, avatarUrl, size = 32 }: { name?: string | null; avatarUrl?: string | null; size?: number }) {
  if (isPhotoAvatarUrl(avatarUrl)) {
    return (
      <img
        src={avatarUrl!}
        alt={name ?? ""}
        className="rounded-full shrink-0 object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  const config = parseAvatarUrl(avatarUrl);
  if (config) return <AvatarRenderer config={config} size={size} className="rounded-full shrink-0" />;
  return (
    <span
      className="flex items-center justify-center rounded-full bg-secondary text-xs font-medium shrink-0"
      style={{ width: size, height: size }}
    >
      {(name ?? "?").charAt(0).toUpperCase()}
    </span>
  );
}
