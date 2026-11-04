"use client"

import { useCallback, useEffect, useRef, type PointerEvent } from "react"
import { TypewriterVisual } from "@/components/typewriter-visual"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import styles from "./sign-in-mobile-typewriter.module.css"

type PermissionCapableEvent = {
  requestPermission?: () => Promise<"granted" | "denied" | "default">
}

const REST_RX = -10
const REST_RY = -20

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function SignInMobileTypewriter({ collapsed }: { collapsed: boolean }) {
  const isMobile = useIsMobile()
  const stageRef = useRef<HTMLDivElement>(null)
  const sensorsActiveRef = useRef(false)
  const sensorsAttachedRef = useRef(false)
  const permissionAttemptedRef = useRef(false)
  const detachSensorsRef = useRef<(() => void) | null>(null)
  const poseRef = useRef({
    tiltRx: REST_RX,
    tiltRy: REST_RY,
    tiltTx: 0,
    tiltTy: 0,
    shakeX: 0,
    shakeY: 0,
    velX: 0,
    velY: 0,
  })
  const targetRef = useRef({ tiltRx: REST_RX, tiltRy: REST_RY, tiltTx: 0, tiltTy: 0 })
  const lastFrameRef = useRef<number | null>(null)
  const resetSensorBaselineRef = useRef<(() => void) | null>(null)
  const rafRef = useRef<number | null>(null)
  const dragPointerRef = useRef<number | null>(null)

  const commitPose = useCallback(() => {
    const el = stageRef.current
    if (!el) return
    const p = poseRef.current
    const rx = clamp(p.tiltRx + p.shakeY * 0.45, REST_RX - 12, REST_RX + 15)
    const ry = clamp(p.tiltRy + p.shakeX * 0.65, -36, -2)
    const tx = clamp(p.tiltTx + p.shakeX, -22, 22)
    const ty = clamp(p.tiltTy + p.shakeY, -16, 16)
    el.style.setProperty("--tw-rx", `${rx.toFixed(2)}deg`)
    el.style.setProperty("--tw-ry", `${ry.toFixed(2)}deg`)
    el.style.setProperty("--tw-tx", `${tx.toFixed(2)}px`)
    el.style.setProperty("--tw-ty", `${ty.toFixed(2)}px`)
  }, [])

  const stepSpring = useCallback(function tick(timestamp: number) {
    const p = poseRef.current
    const target = targetRef.current
    const elapsed = lastFrameRef.current === null ? 1000 / 60 : clamp(timestamp - lastFrameRef.current, 0, 32)
    lastFrameRef.current = timestamp
    const blend = 1 - Math.exp(-elapsed / 100)
    const frame = elapsed / (1000 / 60)
    let moving = false
    for (const key of ["tiltRx", "tiltRy", "tiltTx", "tiltTy"] as const) {
      p[key] += (target[key] - p[key]) * blend
      if (Math.abs(target[key] - p[key]) < 0.01) p[key] = target[key]
      else moving = true
    }
    p.velX = (p.velX - p.shakeX * 0.22 * frame) * Math.pow(0.82, frame)
    p.velY = (p.velY - p.shakeY * 0.22 * frame) * Math.pow(0.82, frame)
    p.shakeX += p.velX * frame
    p.shakeY += p.velY * frame
    if (Math.max(Math.abs(p.shakeX), Math.abs(p.shakeY), Math.abs(p.velX), Math.abs(p.velY)) < 0.08) {
      p.shakeX = 0
      p.shakeY = 0
      p.velX = 0
      p.velY = 0
    } else moving = true
    commitPose()
    if (moving) rafRef.current = window.requestAnimationFrame(tick)
    else {
      rafRef.current = null
      lastFrameRef.current = null
    }
  }, [commitPose])

  const schedulePose = useCallback(() => {
    if (rafRef.current === null) rafRef.current = window.requestAnimationFrame(stepSpring)
  }, [stepSpring])

  const attachSensors = useCallback(() => {
    if (!sensorsActiveRef.current || sensorsAttachedRef.current || typeof window === "undefined") return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    sensorsAttachedRef.current = true

    let baselineBeta: number | null = null
    let baselineGamma: number | null = null
    let prevRawX: number | null = null
    let prevRawY: number | null = null
    let acceptedBeta: number | null = null
    let acceptedGamma: number | null = null
    let lastImpulse = -Infinity
    resetSensorBaselineRef.current = () => {
      baselineBeta = null
      baselineGamma = null
      acceptedBeta = null
      acceptedGamma = null
      prevRawX = null
      prevRawY = null
    }

    const onOrientation = (event: DeviceOrientationEvent) => {
      if (typeof event.beta !== "number" || typeof event.gamma !== "number") return
      if (!Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) return
      if (dragPointerRef.current !== null) return
      if (baselineBeta === null || baselineGamma === null) {
        baselineBeta = event.beta
        baselineGamma = event.gamma
      }
      if (acceptedBeta !== null && acceptedGamma !== null
        && Math.abs(event.beta - acceptedBeta) < 0.5
        && Math.abs(event.gamma - acceptedGamma) < 0.5) return
      acceptedBeta = event.beta
      acceptedGamma = event.gamma
      const dGamma = clamp(event.gamma - baselineGamma, -30, 30)
      const dBeta = clamp(event.beta - baselineBeta, -25, 25)
      targetRef.current.tiltRy = REST_RY + (dGamma / 30) * 16
      targetRef.current.tiltRx = REST_RX - (dBeta / 25) * 12
      targetRef.current.tiltTx = (dGamma / 30) * 16
      targetRef.current.tiltTy = (dBeta / 25) * 11
      schedulePose()
    }

    const onMotion = (event: DeviceMotionEvent) => {
      if (dragPointerRef.current !== null) return
      const linear = event.acceleration
      const gravity = event.accelerationIncludingGravity
      let dx = 0
      let dy = 0
      if (
        linear
        && typeof linear.x === "number"
        && typeof linear.y === "number"
        && (Math.abs(linear.x) > 0.1 || Math.abs(linear.y) > 0.1)
      ) {
        dx = linear.x
        dy = -linear.y
      } else if (gravity && typeof gravity.x === "number" && typeof gravity.y === "number") {
        if (prevRawX !== null && prevRawY !== null) {
          dx = gravity.x - prevRawX
          dy = -(gravity.y - prevRawY)
        }
        prevRawX = gravity.x
        prevRawY = gravity.y
      }
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1.8) return
      const now = performance.now()
      if (now - lastImpulse < 160) return
      lastImpulse = now
      poseRef.current.velX = clamp(poseRef.current.velX + dx * 0.25, -4, 4)
      poseRef.current.velY = clamp(poseRef.current.velY + dy * 0.2, -3, 3)
      schedulePose()
    }

    window.addEventListener("deviceorientation", onOrientation)
    window.addEventListener("devicemotion", onMotion)
    detachSensorsRef.current = () => {
      window.removeEventListener("deviceorientation", onOrientation)
      window.removeEventListener("devicemotion", onMotion)
      sensorsAttachedRef.current = false
      resetSensorBaselineRef.current = null
    }
  }, [schedulePose])

  useEffect(() => {
    if (!isMobile || collapsed) {
      sensorsActiveRef.current = false
      return
    }
    sensorsActiveRef.current = true
    attachSensors()
    return () => {
      sensorsActiveRef.current = false
      detachSensorsRef.current?.()
      detachSensorsRef.current = null
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      lastFrameRef.current = null
      dragPointerRef.current = null
    }
  }, [attachSensors, collapsed, isMobile])

  useEffect(() => {
    if (!isMobile || collapsed) return
    const el = stageRef.current
    if (!el || typeof ResizeObserver !== "function") return
    const updateScale = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const fitW = ((rect.width - 48) / 468) * 0.72
      const fitH = (rect.height - 12) / 512
      const scale = clamp(Math.min(fitW, fitH), 0.24, 0.465)
      el.style.setProperty("--tw-scale", scale.toFixed(3))
    }
    updateScale()
    const observer = new ResizeObserver(updateScale)
    observer.observe(el)
    return () => observer.disconnect()
  }, [collapsed, isMobile])

  const unlockSensorsOnGesture = () => {
    if (!sensorsActiveRef.current || typeof window === "undefined") return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    if (permissionAttemptedRef.current) return
    const orientationCtor = (
      window as Window & { DeviceOrientationEvent?: PermissionCapableEvent }
    ).DeviceOrientationEvent
    const motionCtor = (
      window as Window & { DeviceMotionEvent?: PermissionCapableEvent }
    ).DeviceMotionEvent
    if (typeof orientationCtor?.requestPermission === "function") {
      permissionAttemptedRef.current = true
      void Promise.all([
        orientationCtor.requestPermission().catch(() => null),
        typeof motionCtor?.requestPermission === "function"
          ? motionCtor.requestPermission().catch(() => null)
          : Promise.resolve("denied" as const),
      ]).then(([oriResult, motResult]) => {
        permissionAttemptedRef.current = oriResult === "denied" || (oriResult === "granted" && motResult !== null)
        if (!sensorsActiveRef.current) return
        if (oriResult === "granted" || motResult === "granted") {
          detachSensorsRef.current?.()
          detachSensorsRef.current = null
          attachSensors()
        }
      })
    }
  }

  const updateTouchTilt = (clientX: number, clientY: number) => {
    const el = stageRef.current
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const nx = clamp((clientX - (rect.left + rect.width / 2)) / (rect.width / 2), -1, 1)
    const ny = clamp((clientY - (rect.top + rect.height / 2)) / (rect.height / 2), -1, 1)
    targetRef.current.tiltRy = REST_RY + nx * 16
    targetRef.current.tiltRx = REST_RX - ny * 12
    targetRef.current.tiltTx = nx * 14
    targetRef.current.tiltTy = ny * 10
    schedulePose()
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPointerRef.current !== null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    dragPointerRef.current = event.pointerId
    poseRef.current.velX = 0
    poseRef.current.velY = 0
    event.currentTarget.setPointerCapture?.(event.pointerId)
    updateTouchTilt(event.clientX, event.clientY)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPointerRef.current !== event.pointerId) return
    updateTouchTilt(event.clientX, event.clientY)
  }

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPointerRef.current !== event.pointerId) return
    dragPointerRef.current = null
    resetSensorBaselineRef.current?.()
    if (event.type === "pointerup") unlockSensorsOnGesture()
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    targetRef.current.tiltRy = REST_RY
    targetRef.current.tiltRx = REST_RX
    targetRef.current.tiltTx = 0
    targetRef.current.tiltTy = 0
    schedulePose()
  }

  return (
    <div
      ref={stageRef}
      aria-hidden="true"
      data-testid="sign-in-mobile-typewriter"
      data-collapsed={collapsed ? "true" : "false"}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={handlePointerEnd}
      className={cn(
        styles.stage,
        "relative flex w-full touch-none items-center justify-center transition-opacity duration-200 select-none sm:hidden",
        collapsed
          ? "pointer-events-none h-0 flex-none overflow-hidden opacity-0"
          : "h-48 min-h-0 shrink overflow-visible opacity-100 [@media(min-height:740px)]:h-62",
      )}
    >
      {isMobile && !collapsed ? (
        <TypewriterVisual
          animateEntrance={false}
          blobScale={1.2}
          className={styles.typewriter}
        />
      ) : null}
    </div>
  )
}
