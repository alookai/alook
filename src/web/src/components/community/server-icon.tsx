import { SeededBackdrop } from "@/components/avatar"
import { cn } from "@/lib/utils"

// The one server icon/avatar. A custom uploaded `icon` shows as a cropped
// image; otherwise the fallback is a seeded native backdrop + the server's
// initial in the brand font (white, subtle shadow + text-stroke). This is the
// canonical treatment the server rail uses — Settings, the invite card, and
// anywhere else that shows a server MUST route through here so the fallback
// never diverges into a flat colored box again.
//
// `seed` should be the stable server id so the backdrop never shifts on rename. `size` sets the box;
// `rounded`/`className` let callers tune the corner + framing per surface.
export function ServerIcon({
  id,
  name,
  initial,
  icon,
  size = 40,
  className,
}: {
  id: string
  name: string
  initial: string
  icon?: string | null
  size?: number
  className?: string
}) {
  return (
    <div
      className={cn(
        "relative grid place-items-center overflow-hidden rounded-xl font-brand font-bold",
        icon ? "bg-secondary text-foreground" : "text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.35)]",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
    >
      {icon ? (
        <img src={icon} alt={name} className="size-full object-cover" />
      ) : (
        <>
          <SeededBackdrop seed={id} />
          <span className="relative -translate-x-0.5 [-webkit-text-stroke:0.5px_currentColor]">{initial}</span>
        </>
      )}
    </div>
  )
}
