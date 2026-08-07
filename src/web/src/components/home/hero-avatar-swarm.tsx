import type { CSSProperties } from "react"
import { Avatar } from "@/components/community/avatar"
import styles from "./hero-avatar-swarm.module.css"

type SwarmAvatar = {
  name: string
  seed: string
  size: number
  startX: string
  groundOffset: string
  delay: string
  duration: string
  hop: string
  tilt: string
  path: "bound" | "skip" | "scurry"
}

const HERO_SWARM_AVATARS: readonly SwarmAvatar[] = [
  { name: "Maya", seed: "maya", size: 38, startX: "53%", groundOffset: "0px", delay: "2.64s", duration: "5.6s", hop: "-54px", tilt: "-8deg", path: "bound" },
  { name: "Alli", seed: "alli", size: 34, startX: "47%", groundOffset: "3px", delay: "2.7s", duration: "6.4s", hop: "-38px", tilt: "7deg", path: "scurry" },
  { name: "Tracy", seed: "tracy", size: 30, startX: "61%", groundOffset: "-2px", delay: "2.73s", duration: "5s", hop: "-66px", tilt: "5deg", path: "skip" },
  { name: "Gus", seed: "gus", size: 42, startX: "44%", groundOffset: "2px", delay: "2.91s", duration: "6.9s", hop: "-46px", tilt: "-5deg", path: "bound" },
  { name: "Shelly", seed: "shelly", size: 28, startX: "57%", groundOffset: "1px", delay: "2.94s", duration: "5.2s", hop: "-31px", tilt: "10deg", path: "scurry" },
  { name: "Ruthann", seed: "ruthann", size: 36, startX: "50%", groundOffset: "-3px", delay: "3.02s", duration: "6s", hop: "-72px", tilt: "-9deg", path: "skip" },
  { name: "Nova", seed: "nova", size: 26, startX: "64%", groundOffset: "2px", delay: "3.46s", duration: "4.6s", hop: "-36px", tilt: "6deg", path: "scurry" },
  { name: "Jun", seed: "jun", size: 32, startX: "40%", groundOffset: "0px", delay: "3.5s", duration: "6.7s", hop: "-58px", tilt: "-7deg", path: "bound" },
  { name: "Ada", seed: "ada", size: 40, startX: "55%", groundOffset: "4px", delay: "3.53s", duration: "5.8s", hop: "-42px", tilt: "8deg", path: "skip" },
  { name: "Milo", seed: "milo", size: 29, startX: "59%", groundOffset: "-4px", delay: "3.7s", duration: "4.8s", hop: "-63px", tilt: "-11deg", path: "bound" },
  { name: "Iris", seed: "iris", size: 35, startX: "46%", groundOffset: "-1px", delay: "3.98s", duration: "6.5s", hop: "-48px", tilt: "4deg", path: "scurry" },
  { name: "Theo", seed: "theo", size: 24, startX: "63%", groundOffset: "3px", delay: "4.02s", duration: "4.5s", hop: "-29px", tilt: "12deg", path: "skip" },
  { name: "Nia", seed: "nia", size: 39, startX: "42%", groundOffset: "1px", delay: "4.04s", duration: "7.2s", hop: "-55px", tilt: "-6deg", path: "bound" },
  { name: "Remy", seed: "remy", size: 31, startX: "52%", groundOffset: "4px", delay: "4.09s", duration: "5.4s", hop: "-34px", tilt: "9deg", path: "scurry" },
  { name: "Sol", seed: "sol", size: 27, startX: "60%", groundOffset: "-2px", delay: "4.51s", duration: "5.1s", hop: "-61px", tilt: "-10deg", path: "skip" },
  { name: "Kira", seed: "kira", size: 37, startX: "48%", groundOffset: "0px", delay: "4.55s", duration: "6.1s", hop: "-44px", tilt: "5deg", path: "bound" },
  { name: "Pax", seed: "pax", size: 25, startX: "56%", groundOffset: "2px", delay: "4.6s", duration: "4.7s", hop: "-33px", tilt: "-12deg", path: "scurry" },
  { name: "Lumi", seed: "lumi", size: 41, startX: "39%", groundOffset: "-4px", delay: "4.94s", duration: "7.3s", hop: "-69px", tilt: "7deg", path: "skip" },
  { name: "Orin", seed: "orin", size: 33, startX: "58%", groundOffset: "1px", delay: "4.99s", duration: "5.7s", hop: "-41px", tilt: "-4deg", path: "bound" },
  { name: "Zadie", seed: "zadie", size: 28, startX: "45%", groundOffset: "3px", delay: "5.36s", duration: "6.6s", hop: "-52px", tilt: "11deg", path: "scurry" },
]

export function HeroAvatarSwarm() {
  return (
    <div className={styles.swarm} data-testid="landing-hero-avatar-swarm" aria-hidden="true">
      {HERO_SWARM_AVATARS.map((avatar) => (
        <span
          key={avatar.seed}
          className={styles.runner}
          data-path={avatar.path}
          style={
            {
              "--avatar-start-x": avatar.startX,
              "--avatar-size": `${avatar.size}px`,
              "--avatar-ground-offset": avatar.groundOffset,
              "--avatar-delay": avatar.delay,
              "--avatar-duration": avatar.duration,
              "--avatar-hop": avatar.hop,
              "--avatar-tilt": avatar.tilt,
            } as CSSProperties
          }
        >
          <span className={styles.shadow} />
          <span className={styles.face}>
            <Avatar label={avatar.name} seed={avatar.seed} size={avatar.size} />
          </span>
        </span>
      ))}
    </div>
  )
}
