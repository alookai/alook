"use client";

import { useEffect, useRef, useState } from "react";
import { BoringAvatar } from "./boring-avatar";
import { resolveAvatar } from "@/lib/avatar/resolve";

// beam is a static SVG with no animatable internal parts, so only the
// container-level animations survive the migration off the procedural
// renderer (shape/eye/nose-targeted anims are dropped — see plan tradeoff).
const ANIMATIONS = ["avatar-anim-pulse", "avatar-anim-float"] as const;

interface AnimatedAvatarProps {
  seed: string;
  avatarUrl?: string | null;
  size?: number;
  className?: string;
  isHovered: boolean;
  isWorking?: boolean;
}

export function AnimatedAvatar({ seed, avatarUrl, size, className, isHovered, isWorking }: AnimatedAvatarProps) {
  const [animClass, setAnimClass] = useState<string | null>(null);
  const lastPickRef = useRef(-1);

  function pickAnimation() {
    let idx = Math.floor(Math.random() * ANIMATIONS.length);
    if (idx === lastPickRef.current) idx = (idx + 1) % ANIMATIONS.length;
    lastPickRef.current = idx;
    return ANIMATIONS[idx]!;
  }

  useEffect(() => {
    if (isHovered) {
      setAnimClass(pickAnimation());
    } else if (!isWorking) {
      setAnimClass(null);
    }
  }, [isHovered, isWorking]);

  useEffect(() => {
    if (!isWorking) {
      if (!isHovered) setAnimClass(null);
      return;
    }
    setAnimClass(pickAnimation());
    const interval = setInterval(() => {
      setAnimClass(pickAnimation());
    }, 4000);
    return () => clearInterval(interval);
  }, [isHovered, isWorking]);

  const resolved = resolveAvatar(avatarUrl, seed);
  return (
    <div className={animClass ?? undefined}>
      {resolved.kind === "photo" ? (
        <img src={resolved.url} alt="" className={`object-cover ${className ?? ""}`} style={{ width: size, height: size }} />
      ) : (
        <BoringAvatar seed={resolved.seed} size={size} className={className} />
      )}
    </div>
  );
}
