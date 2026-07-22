"use client";

import Avatar from "boring-avatars";
import { paletteFromSeed } from "@/lib/avatar/boring-palettes";

/**
 * The single wrapper around boring-avatars. Every generated avatar/gradient in
 * the app renders through here so the library stays isolated behind one
 * component. `seed` maps to boring-avatars' `name` prop (deterministic), and
 * the palette is chosen deterministically from the same seed.
 *
 * `beam` (default) is the face fallback; `marble` is the gradient background
 * used for server/channel icons and the profile banner.
 */
export function BoringAvatar({
  seed,
  size = 40,
  variant = "beam",
  square = false,
  className,
  preserveAspectRatio,
}: {
  seed: string;
  size?: number | string;
  variant?: "beam" | "marble";
  square?: boolean;
  className?: string;
  preserveAspectRatio?: string;
}) {
  return (
    <Avatar
      size={size}
      name={seed}
      variant={variant}
      colors={paletteFromSeed(seed)}
      square={square}
      className={className}
      preserveAspectRatio={preserveAspectRatio}
    />
  );
}
