"use client";

import Avatar from "boring-avatars";
import { paletteFromSeed } from "@/lib/avatar/boring-palettes";
import { renderFaceSvg } from "@/lib/avatar/face";
import { cn } from "@/lib/utils";

/**
 * The single wrapper around boring-avatars. Every generated avatar/gradient in
 * the app renders through here so the library stays isolated behind one
 * component. `seed` maps to boring-avatars' `name` prop (deterministic), and
 * the palette is chosen deterministically from the same seed.
 *
 * `beam` (default) is the face fallback — rendered by our own `renderFaceSvg`
 * (richer shape/eye/mouth vocabulary than the lib's fixed beam), same 36-unit
 * canvas + seed-derived palette so it drops into the same crop. `marble` is the
 * gradient background (server/channel icons, profile banner) and stays on the
 * lib.
 *
 * `square` defaults to true so the underlying SVG is a full square that the
 * container's radius crops — matching how photo `object-cover` avatars behave.
 * The crop is done here, at one place, by a wrapper span that co-locates the
 * caller's `className` (which carries the radius, e.g. `rounded-full` /
 * `rounded-xl`) with `overflow-hidden`: `overflow-hidden` clips to the
 * border-box, so the radius must live on the SAME element or a circular caller
 * would clip to a rectangle. The span gets an explicit box (`inline-flex` +
 * `size`) because standalone callers pass a numeric `size` with no flex parent,
 * and a bare inline span would ignore width/height and collapse.
 */
export function BoringAvatar({
  seed,
  size = 40,
  variant = "beam",
  square = true,
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
    <span className={cn("inline-flex overflow-hidden align-middle", className)} style={{ width: size, height: size }}>
      {variant === "beam" ? (
        // Our generated face — self-contained SVG (viewBox 0 0 36 36, 100% w/h),
        // fills the crop span exactly like the lib's `size="100%"` did.
        <span className="size-full [&>svg]:block [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: renderFaceSvg(seed, paletteFromSeed(seed)) }} />
      ) : (
        <Avatar
          size="100%"
          name={seed}
          variant={variant}
          colors={paletteFromSeed(seed)}
          square={square}
          className="size-full"
          preserveAspectRatio={preserveAspectRatio}
        />
      )}
    </span>
  );
}
