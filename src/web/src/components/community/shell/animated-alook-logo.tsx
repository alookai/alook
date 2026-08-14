"use client"

import { useEffect, useId, useRef, type RefObject } from "react"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"

export const REVEAL_MATRIX = [0.82598, 0, 0, 0.82599, 194.784, 194.424] as const
export const MOTION_OFFSETS = [0, 0.55, 0.73, 0.88, 1] as const
export const ENTER_PROGRESS = [0, 1.06, 0.975, 1.01, 1] as const
export const EXIT_PROGRESS = [1, -0.06, 0.025, -0.01, 0] as const
export const MOTION_DURATION_MS = 300

const segmentEasings = [
  cubicBezier(0.2, 0.8, 0.2, 1),
  cubicBezier(0.42, 0, 0.58, 1),
  cubicBezier(0.42, 0, 0.58, 1),
  cubicBezier(0, 0, 0.58, 1),
]

export function transformForProgress(progress: number) {
  const [targetA, , , targetD, targetE, targetF] = REVEAL_MATRIX
  const a = 1 + (targetA - 1) * progress
  const d = 1 + (targetD - 1) * progress
  return `matrix(${formatNumber(a)} 0 0 ${formatNumber(d)} ${formatNumber(targetE * progress)} ${formatNumber(targetF * progress)})`
}

export function motionProgressAt(targetReveal: boolean, startProgress: number, elapsedMs: number) {
  if (elapsedMs >= MOTION_DURATION_MS) return targetReveal ? 1 : 0
  const points: number[] = targetReveal ? [...ENTER_PROGRESS] : [...EXIT_PROGRESS]
  points[0] = startProgress
  const elapsed = Math.max(0, elapsedMs) / MOTION_DURATION_MS
  let segment = MOTION_OFFSETS.length - 2
  for (let index = 0; index < MOTION_OFFSETS.length - 1; index += 1) {
    if (elapsed <= MOTION_OFFSETS[index + 1]) {
      segment = index
      break
    }
  }
  const fromOffset = MOTION_OFFSETS[segment]
  const toOffset = MOTION_OFFSETS[segment + 1]
  const local = (elapsed - fromOffset) / (toOffset - fromOffset)
  const eased = segmentEasings[segment](Math.max(0, Math.min(1, local)))
  return points[segment] + (points[segment + 1] - points[segment]) * eased
}

function formatNumber(value: number) {
  const rounded = Math.abs(value) < 0.000005 ? 0 : Number(value.toFixed(5))
  return String(rounded)
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const sample = (t: number, a1: number, a2: number) =>
    ((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + 3 * a1 * t
  const slope = (t: number, a1: number, a2: number) =>
    3 * (1 - 3 * a2 + 3 * a1) * t * t + 2 * (3 * a2 - 6 * a1) * t + 3 * a1

  return (x: number) => {
    let t = x
    for (let index = 0; index < 8; index += 1) {
      const currentSlope = slope(t, x1, x2)
      if (Math.abs(currentSlope) < 0.000001) break
      t -= (sample(t, x1, x2) - x) / currentSlope
    }
    if (t < 0 || t > 1) {
      let low = 0
      let high = 1
      t = x
      for (let index = 0; index < 12; index += 1) {
        if (sample(t, x1, x2) < x) low = t
        else high = t
        t = (low + high) / 2
      }
    }
    return sample(t, y1, y2)
  }
}

function useLogoMotion(
  svgRef: RefObject<SVGSVGElement | null>,
  foregroundRef: RefObject<SVGGElement | null>,
) {
  const frameRef = useRef<number | null>(null)
  const progressRef = useRef(0)
  const targetRef = useRef(false)

  useEffect(() => {
    const svg = svgRef.current
    const foreground = foregroundRef.current
    const trigger = svg?.parentElement
    if (!svg || !foreground || !trigger) return

    const expressions = [...svg.querySelectorAll<SVGGElement>('[data-part="expression"]')]
    const mobileQuery = window.matchMedia("(max-width: 639px)")
    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    let hovered = trigger.matches(":hover")
    let focused = trigger === document.activeElement

    const apply = (progress: number, state: "default" | "reveal" | "transitioning") => {
      progressRef.current = progress
      foreground.setAttribute("transform", transformForProgress(progress))
      for (const expression of expressions) {
        expression.setAttribute("opacity", formatNumber(Math.max(0, Math.min(1, progress))))
      }
      svg.dataset.state = state
    }

    const stop = () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }

    const setTarget = (reveal: boolean) => {
      const nextReveal = mobileQuery.matches ? false : reveal
      const direct = reducedMotionQuery.matches || mobileQuery.matches
      if (!direct && targetRef.current === nextReveal && frameRef.current !== null) return
      targetRef.current = nextReveal
      stop()
      const terminalProgress = nextReveal ? 1 : 0
      if (direct || Math.abs(progressRef.current - terminalProgress) < 0.00001) {
        apply(nextReveal ? 1 : 0, nextReveal ? "reveal" : "default")
        return
      }
      const startProgress = progressRef.current
      const startedAt = performance.now()
      const tick = (now: number) => {
        if (targetRef.current !== nextReveal) return
        const elapsed = now - startedAt
        const done = elapsed >= MOTION_DURATION_MS
        const progress = motionProgressAt(nextReveal, startProgress, elapsed)
        apply(progress, done ? (nextReveal ? "reveal" : "default") : "transitioning")
        if (!done) frameRef.current = requestAnimationFrame(tick)
        else frameRef.current = null
      }
      frameRef.current = requestAnimationFrame(tick)
    }

    const syncTarget = () => setTarget(hovered || focused)
    const onPointerEnter = () => { hovered = true; syncTarget() }
    const onPointerLeave = () => { hovered = false; syncTarget() }
    const onFocus = () => { focused = true; syncTarget() }
    const onBlur = () => { focused = false; syncTarget() }
    const onMediaChange = () => syncTarget()

    trigger.addEventListener("pointerenter", onPointerEnter)
    trigger.addEventListener("pointerleave", onPointerLeave)
    trigger.addEventListener("focus", onFocus)
    trigger.addEventListener("blur", onBlur)
    mobileQuery.addEventListener("change", onMediaChange)
    reducedMotionQuery.addEventListener("change", onMediaChange)
    syncTarget()

    return () => {
      stop()
      trigger.removeEventListener("pointerenter", onPointerEnter)
      trigger.removeEventListener("pointerleave", onPointerLeave)
      trigger.removeEventListener("focus", onFocus)
      trigger.removeEventListener("blur", onBlur)
      mobileQuery.removeEventListener("change", onMediaChange)
      reducedMotionQuery.removeEventListener("change", onMediaChange)
    }
  }, [foregroundRef, svgRef])
}

export function AnimatedAlookLogo({ className }: { className?: string }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const foregroundRef = useRef<SVGGElement>(null)
  const clipId = `alook-logo-${useId().replaceAll(":", "")}`
  useLogoMotion(svgRef, foregroundRef)

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 1024 1024"
      fill="none"
      role="img"
      aria-label="Alook"
      data-testid={tid.alookLogo}
      data-state="default"
      className={cn("pointer-events-none select-none", className)}
    >
      <g clipPath={`url(#${clipId})`}>
        <g data-face="red">
          <path d="M-26.5996 311.221L-39.86 185.057C-55.9935 31.5572 22.3761 -72.3481 148.875 -102.651C194.472 -113.822 206.766 -178.893 309.8 -189.722C482.225 -207.845 613.345 -72.8086 633.015 114.335L646.275 240.499C658.431 356.149 559.924 430.282 328.623 454.592C97.3226 478.903 -14.4443 426.871 -26.5996 311.221Z" fill="#FE4365" />
          <g data-part="expression" opacity="0">
            <path d="M210.59 140.663C225.106 139.137 234.746 117.66 232.122 92.6914C229.498 67.7233 215.603 48.7195 201.086 50.2452C186.57 51.771 176.93 73.2485 179.554 98.2166C182.178 123.185 196.073 142.189 210.59 140.663Z" fill="white" />
            <path d="M378.808 122.982C393.325 121.457 402.965 99.979 400.341 75.0109C397.717 50.0428 383.822 31.039 369.305 32.5647C354.789 34.0904 345.148 55.5679 347.773 80.536C350.397 105.504 364.292 124.508 378.808 122.982Z" fill="white" />
            <path d="M328.063 167.848C333.26 162.502 341.807 162.382 347.153 167.579C352.499 172.777 352.619 181.324 347.421 186.67C334.382 200.08 319.562 208.689 302.962 210.434C286.361 212.178 270.075 206.839 254.533 196.433C248.337 192.284 246.678 183.899 250.826 177.704C254.974 171.509 263.36 169.849 269.555 173.997C281.456 181.966 291.507 184.489 300.139 183.581C308.771 182.674 318.079 178.117 328.063 167.848Z" fill="white" />
          </g>
        </g>
        <g data-face="purple">
          <path d="M523.747 365.154L550.571 58.5595C556.271 -6.59189 611.194 -38.4735 678.261 -32.6059L1015.52 -3.09997C1082.58 2.76768 1131.14 43.7023 1125.44 108.854L1098.61 415.448C1089.89 515.091 998.635 565.034 797.433 547.431C596.23 529.828 515.03 464.797 523.747 365.154Z" fill="#8A5A9E" />
          <g data-part="expression" opacity="0">
            <path d="M746.769 191.001C764.76 192.575 780.621 179.267 782.195 161.276C783.769 143.285 770.46 127.424 752.469 125.85C734.478 124.276 718.618 137.585 717.044 155.576C715.47 173.567 728.778 189.427 746.769 191.001Z" fill="white" />
            <path d="M900.067 204.413C918.058 205.987 933.918 192.679 935.492 174.688C937.066 156.697 923.758 140.836 905.767 139.262C887.776 137.688 871.915 150.997 870.341 168.988C868.767 186.979 882.076 202.839 900.067 204.413Z" fill="white" />
            <path d="M879.218 239.983C885.568 236.076 893.884 238.055 897.791 244.405C901.699 250.755 899.719 259.07 893.37 262.978C867.707 278.77 841.761 286.237 815.871 283.972C789.981 281.707 765.725 269.847 743.194 249.839C737.62 244.888 737.114 236.355 742.065 230.78C747.016 225.206 755.549 224.7 761.124 229.651C780.399 246.769 799.403 255.428 818.224 257.075C837.045 258.721 857.264 253.493 879.218 239.983Z" fill="white" />
          </g>
        </g>
        <g data-face="teal">
          <path d="M-78.815 606.38L-85.9302 504.628C-93.0454 402.877 -38.9437 347.969 34.4882 325.793C26.946 266.675 72.4141 234.525 120.811 268.632C135.789 214.756 212.103 209.42 232.856 262.501C282.701 219.82 339.34 249.943 336.588 308.076C405.846 323.683 449.748 366.625 456.745 466.681L463.86 568.432C470.382 661.705 389.147 718.51 202.602 731.554C16.0577 744.599 -72.2928 699.652 -78.815 606.38Z" fill="#45ADA8" />
          <g data-part="expression" opacity="0">
            <path d="M112.83 422.564C129.98 421.365 145.457 430.644 158.934 444.695C164.133 450.116 163.953 458.725 158.532 463.924C153.111 469.123 144.502 468.944 139.303 463.523C128.271 452.021 120.188 449.315 114.727 449.697C109.266 450.079 101.638 453.884 92.3142 466.809C87.92 472.9 79.4196 474.276 73.3281 469.882C67.2366 465.488 65.8599 456.988 70.254 450.896C81.644 435.107 95.6792 423.763 112.83 422.564ZM248.498 413.077C265.649 411.878 281.126 421.157 294.603 435.208C299.802 440.629 299.621 449.238 294.201 454.437C288.78 459.636 280.171 459.457 274.972 454.036C263.94 442.534 255.857 439.828 250.396 440.21C244.935 440.592 237.307 444.397 227.983 457.322C223.589 463.414 215.088 464.789 208.997 460.395C202.905 456.001 201.529 447.501 205.923 441.409C217.313 425.62 231.348 414.276 248.498 413.077Z" fill="black" />
            <path d="M237.886 492.175C243.232 487.591 251.282 488.21 255.865 493.556C260.449 498.901 259.83 506.951 254.484 511.535C234.167 528.953 212.389 539.153 189.261 540.77C166.134 542.387 143.149 535.318 120.604 520.896C114.673 517.102 112.94 509.216 116.734 503.285C120.529 497.353 128.415 495.62 134.346 499.415C153.427 511.621 171.04 516.482 187.483 515.332C203.925 514.182 220.69 506.917 237.886 492.175Z" fill="black" />
          </g>
        </g>
        <g data-face="blue">
          <path d="M-109.988 949.35L-99.7556 851.999C-85.7718 718.952 24.7154 635.419 172.106 637.787C331.026 639.726 436.163 747.563 419.451 906.57L409.219 1003.92C399.839 1093.16 313.597 1133.31 135.12 1114.55C-43.357 1095.79 -119.367 1038.59 -109.988 949.35Z" fill="#6A8CAF" />
          <g data-part="expression" opacity="0">
            <path d="M96.9934 852.993C113.123 854.688 127.573 842.987 129.268 826.857C130.964 810.728 119.262 796.278 103.133 794.582C87.0029 792.887 72.5529 804.588 70.8576 820.718C69.1623 836.848 80.8637 851.298 96.9934 852.993Z" fill="black" />
            <path d="M254.259 830.894C259.753 826.445 267.814 827.292 272.263 832.786C276.711 838.28 275.864 846.339 270.371 850.788C256.884 861.71 242.205 868.002 226.821 866.385C211.437 864.768 198.388 855.562 187.467 842.075C183.018 836.581 183.865 828.521 189.359 824.072C194.853 819.623 202.913 820.471 207.361 825.964C215.8 836.385 223.247 840.269 229.497 840.926C235.747 841.582 243.839 839.332 254.259 830.894Z" fill="black" />
            <path d="M88.7148 884.932C130.907 930.924 177.419 935.813 228.252 899.598C219.15 944.573 193.506 964.844 151.321 960.41C109.135 955.977 88.2666 930.817 88.7148 884.932Z" fill="black" />
          </g>
        </g>
        <g ref={foregroundRef} data-face="orange" data-motion-layer="foreground" transform={transformForProgress(0)}>
          <path d="M73.3744 799.986L80.287 602.034C88.6974 361.193 232.448 217.568 434.621 198.202C507.549 190.84 540.698 92.9006 702.358 98.5459C972.892 107.993 1146.28 345.273 1136.03 638.902L1129.12 836.853C1122.78 1018.31 954.364 1111.52 591.453 1098.85C228.541 1086.18 67.0378 981.442 73.3744 799.986Z" fill="#FF9915" />
          <path d="M499.787 535.435C538.186 535.435 569.315 505.031 569.315 467.525C569.315 430.019 538.186 399.614 499.787 399.614C461.388 399.614 430.26 430.019 430.26 467.525C430.26 505.031 461.388 535.435 499.787 535.435Z" fill="white" />
          <path d="M522.424 513.445C540.641 513.445 555.409 498.677 555.409 480.46C555.409 462.243 540.641 447.475 522.424 447.475C504.207 447.475 489.439 462.243 489.439 480.46C489.439 498.677 504.207 513.445 522.424 513.445Z" fill="black" />
          <path d="M758.494 535.435C796.893 535.435 828.021 505.031 828.021 467.525C828.021 430.019 796.893 399.614 758.494 399.614C720.095 399.614 688.966 430.019 688.966 467.525C688.966 505.031 720.095 535.435 758.494 535.435Z" fill="white" />
          <path d="M781.131 513.445C799.348 513.445 814.116 498.677 814.116 480.46C814.116 462.243 799.348 447.475 781.131 447.475C762.914 447.475 748.146 462.243 748.146 480.46C748.146 498.677 762.914 513.445 781.131 513.445Z" fill="black" />
          <path d="M711.48 571.1C722.145 562.995 737.361 565.07 745.466 575.735C753.571 586.399 751.496 601.615 740.832 609.72C680.61 655.489 608.609 669.247 527.369 652.999C514.235 650.372 505.716 637.594 508.343 624.459C510.971 611.325 523.748 602.806 536.883 605.433C606.555 619.368 663.908 607.255 711.48 571.1Z" fill="black" />
        </g>
      </g>
      <defs>
        <clipPath id={clipId}>
          <rect width="1024" height="1024" rx="236" fill="white" />
        </clipPath>
      </defs>
    </svg>
  )
}
