"use client";

import { useEffect, useRef, useState } from "react";
import { AvatarRenderer } from "./avatar-parts";
import type { AvatarConfig } from "./avatar-parts";

const ANIMATIONS = [
  "avatar-anim-shape-bounce",
  "avatar-anim-head-tilt",
  "avatar-anim-shake",
  "avatar-anim-wobble",
  "avatar-anim-pulse",
  "avatar-anim-spin",
  "avatar-anim-jelly",
  "avatar-anim-float",
  "avatar-anim-nod",
] as const;

interface AnimatedAvatarProps {
  config: AvatarConfig;
  size?: number;
  className?: string;
  isHovered: boolean;
  isWorking?: boolean;
}

export function AnimatedAvatar({ config, size, className, isHovered, isWorking }: AnimatedAvatarProps) {
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

  return (
    <div className={animClass ?? undefined}>
      <AvatarRenderer config={config} size={size} className={className} />
    </div>
  );
}
