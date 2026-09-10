import { GeneratedAvatar } from "@/components/avatar"

const studioBotSeeds = ["studio-lantern", "studio-pocket", "studio-orbit"]

export function PlanBots({ className, botClassName, avatarClassName }: { className: string; botClassName: string; avatarClassName?: string }) {
  return <div className={className} aria-hidden="true">{studioBotSeeds.map((seed) => <span className={botClassName} key={seed}><GeneratedAvatar seed={seed} size="100%" className={avatarClassName} /></span>)}</div>
}

export function PlanBarcode({ className }: { className: string }) {
  return <div className={className} aria-hidden="true">{Array.from({ length: 25 }, (_, index) => <span key={index} data-wide={index % 7 === 0 || index % 11 === 0 || undefined} />)}</div>
}
