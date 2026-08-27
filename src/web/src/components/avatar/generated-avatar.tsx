import { renderFaceSvg } from "@/lib/avatar/face"
import { cn } from "@/lib/utils"

export function GeneratedAvatar({
  seed,
  size = 40,
  className,
  motionParts = false,
}: {
  seed: string
  size?: number | string
  className?: string
  motionParts?: boolean
}) {
  return (
    <span className={cn("inline-flex overflow-hidden align-middle", className)} style={{ width: size, height: size }}>
      <span
        className="size-full [&>svg]:block [&>svg]:size-full"
        dangerouslySetInnerHTML={{ __html: renderFaceSvg(seed, { motionParts }) }}
      />
    </span>
  )
}
