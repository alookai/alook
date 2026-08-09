import { renderSeededBackdropSvg } from "@/lib/avatar/backdrop"

export function SeededBackdrop({ seed }: { seed: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 [&>svg]:block [&>svg]:size-full"
      dangerouslySetInnerHTML={{ __html: renderSeededBackdropSvg(seed) }}
    />
  )
}
