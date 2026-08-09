import { avatarHash, avatarThemeFromSeed } from "./theme"

export type SeededBackdropVariant = "profile" | "icon"

const MARBLE_SIZE = 80
const MARBLE_LAYERS = 3

function digit(value: number, position: number): number {
  return Math.floor((value / 10 ** position) % 10)
}

function signedModulo(value: number, maximum: number, signDigit?: number): number {
  const remainder = value % maximum
  return signDigit !== undefined && digit(value, signDigit) % 2 === 0 ? -remainder : remainder
}

/**
 * Faithful local port of boring-avatars@2.0.4's marble data function.
 * Keep the seemingly odd first-path `layers[2].scale` use below: the upstream
 * implementation does that too, and changing it would change existing visuals.
 */
function marbleLayersFromSeed(seed: string) {
  const hash = avatarHash(seed)
  const palette = avatarThemeFromSeed(seed).palette
  return Array.from({ length: MARBLE_LAYERS }, (_, index) => {
    const value = hash * (index + 1)
    return {
      color: palette[(hash + index) % palette.length],
      translateX: signedModulo(value, MARBLE_SIZE / 10, 1),
      translateY: signedModulo(value, MARBLE_SIZE / 10, 2),
      scale: 1.2 + signedModulo(value, MARBLE_SIZE / 20) / 10,
      rotate: signedModulo(value, 360, 1),
    }
  })
}

export function renderSeededBackdropSvg(seed: string, variant: SeededBackdropVariant): string {
  const layers = marbleLayersFromSeed(seed)
  const id = `alook-marble-${avatarHash(`${seed}:${variant}`)}`
  const maskId = `${id}-mask`
  const filterId = `${id}-filter`

  return `<svg viewBox="0 0 80 80" fill="none" width="100%" height="100%" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="80" height="80"><rect width="80" height="80" fill="#FFFFFF"/></mask><g mask="url(#${maskId})"><rect width="80" height="80" fill="${layers[0].color}"/><path filter="url(#${filterId})" d="M32.414 59.35L50.376 70.5H72.5v-71H33.728L26.5 13.381l19.057 27.08L32.414 59.35z" fill="${layers[1].color}" transform="translate(${layers[1].translateX} ${layers[1].translateY}) rotate(${layers[1].rotate} 40 40) scale(${layers[2].scale})"/><path filter="url(#${filterId})" style="mix-blend-mode:overlay" d="M22.216 24L0 46.75l14.108 38.129L78 86l-3.081-59.276-22.378 4.005 12.972 20.186-23.35 27.395L22.215 24z" fill="${layers[2].color}" transform="translate(${layers[2].translateX} ${layers[2].translateY}) rotate(${layers[2].rotate} 40 40) scale(${layers[2].scale})"/></g><defs><filter id="${filterId}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="7" result="effect1_foregroundBlur"/></filter></defs></svg>`
}
