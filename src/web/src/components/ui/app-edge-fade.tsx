import { cn } from "@/lib/utils"

export function AppEdgeFade({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      aria-hidden="true"
      data-slot="app-edge-fade"
      className={cn("pointer-events-none absolute inset-0 z-10", className)}
    >
      <div
        data-app-edge="top"
        className="absolute inset-x-0 top-0 h-(--app-edge-fade-size) bg-linear-to-b from-(--app-bg) to-transparent"
      />
      <div
        data-app-edge="bottom"
        className="absolute inset-x-0 bottom-0 h-(--app-edge-fade-size) bg-linear-to-b from-transparent to-(--app-bg)"
      />
    </div>
  )
}
