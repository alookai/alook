"use client"

import { useCallback, useEffect, useRef, type PointerEvent } from "react"
import { TypewriterVisual } from "@/components/typewriter-visual"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import styles from "./sign-in-mobile-typewriter.module.css"

type PermissionCapableEvent = {
  requestPermission?: () => Promise<"granted" | "denied" | "default">
}

const REST_RX = 11
const REST_RY = -19

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function SignInMobileTypewriter({ collapsed }: { collapsed: boolean }) {
  const isMobile = useIsMobile()
  const stageRef = useRef<HTMLDivElement>(null)
  const sensorsActiveRef = useRef(false)
  const sensorsAttachedRef = useRef(false)
  const receivedSensorEventRef = useRef(false)
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
  const rafRef = useRef<number | null>(null)
  const dragPointerRef = useRef<number | null>(null)

  const commitPose = useCallback(() => {
    const el = stageRef.current
    if (!el) return
    const p = poseRef.current
    const rx = clamp(p.tiltRx + p.shakeY * 0.45, -2, 25)
    const ry = clamp(p.tiltRy + p.shakeX * 0.65, -36, -2)
    const tx = clamp(p.tiltTx + p.shakeX, -22, 22)
    const ty = clamp(p.tiltTy + p.shakeY, -16, 16)
    el.style.setProperty("--tw-rx", `${rx.toFixed(2)}deg`)
    el.style.setProperty("--tw-ry", `${ry.toFixed(2)}deg`)
    el.style.setProperty("--tw-tx", `${tx.toFixed(2)}px`)
    el.style.setProperty("--tw-ty", `${ty.toFixed(2)}px`)
  }, [])

  const stepSpring = useCallback(function tick() {
    const p = poseRef.current
    p.velX = (p.velX - p.shakeX * 0.22) * 0.82
    p.velY = (p.velY - p.shakeY * 0.22) * 0.82
    p.shakeX += p.velX
    p.shakeY += p.velY
    commitPose()
    if (
      Math.abs(p.shakeX) > 0.08
      || Math.abs(p.shakeY) > 0.08
      || Math.abs(p.velX) > 0.08
      || Math.abs(p.velY) > 0.08
    ) {
      rafRef.current = window.requestAnimationFrame(tick)
    } else {
      p.shakeX = 0
      p.shakeY = 0
      p.velX = 0
      p.velY = 0
      rafRef.current = null
      commitPose()
    }
  }, [commitPose])

  const attachSensors = useCallback(() => {
    if (!sensorsActiveRef.current || sensorsAttachedRef.current || typeof window === "undefined") return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    sensorsAttachedRef.current = true

    let baselineBeta: number | null = null
    let baselineGamma: number | null = null
    let prevRawX: number | null = null
    let prevRawY: number | null = null

    const onOrientation = (event: DeviceOrientationEvent) => {
      if (typeof event.beta !== "number" || typeof event.gamma !== "number") return
      if (!Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) return
      receivedSensorEventRef.current = true
      if (dragPointerRef.current !== null) return
      if (baselineBeta === null || baselineGamma === null) {
        baselineBeta = event.beta
        baselineGamma = event.gamma
      }
      const dGamma = clamp(event.gamma - baselineGamma, -30, 30)
      const dBeta = clamp(event.beta - baselineBeta, -25, 25)
      poseRef.current.tiltRy = REST_RY + (dGamma / 30) * 16
      poseRef.current.tiltRx = REST_RX - (dBeta / 25) * 12
      poseRef.current.tiltTx = (dGamma / 30) * 16
      poseRef.current.tiltTy = (dBeta / 25) * 11
      commitPose()
    }

    const onMotion = (event: DeviceMotionEvent) => {
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
        receivedSensorEventRef.current = true
        dx = linear.x
        dy = -linear.y
      } else if (gravity && typeof gravity.x === "number" && typeof gravity.y === "number") {
        receivedSensorEventRef.current = true
        if (prevRawX !== null && prevRawY !== null) {
          dx = gravity.x - prevRawX
          dy = -(gravity.y - prevRawY)
        }
        prevRawX = gravity.x
        prevRawY = gravity.y
      }
      if (Math.hypot(dx, dy) < 1.8) return
      poseRef.current.velX = clamp(poseRef.current.velX + dx * 0.9, -15, 15)
      poseRef.current.velY = clamp(poseRef.current.velY + dy * 0.7, -11, 11)
      if (rafRef.current === null) {
        rafRef.current = window.requestAnimationFrame(stepSpring)
      }
    }

    window.addEventListener("deviceorientation", onOrientation)
    window.addEventListener("devicemotion", onMotion)
    detachSensorsRef.current = () => {
      window.removeEventListener("deviceorientation", onOrientation)
      window.removeEventListener("devicemotion", onMotion)
      sensorsAttachedRef.current = false
    }
  }, [commitPose, stepSpring])

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
    if (receivedSensorEventRef.current || permissionAttemptedRef.current) return
    const orientationCtor = (
      window as Window & { DeviceOrientationEvent?: PermissionCapableEvent }
    ).DeviceOrientationEvent
    const motionCtor = (
      window as Window & { DeviceMotionEvent?: PermissionCapableEvent }
    ).DeviceMotionEvent
    if (typeof orientationCtor?.requestPermission === "function") {
      permissionAttemptedRef.current = true
      void Promise.all([
        orientationCtor.requestPermission().catch(() => "denied" as const),
        typeof motionCtor?.requestPermission === "function"
          ? motionCtor.requestPermission().catch(() => "denied" as const)
          : Promise.resolve("denied" as const),
      ]).then(([oriResult, motResult]) => {
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
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const nx = clamp((clientX - (rect.left + rect.width / 2)) / (rect.width / 2), -1, 1)
    const ny = clamp((clientY - (rect.top + rect.height / 2)) / (rect.height / 2), -1, 1)
    poseRef.current.tiltRy = REST_RY + nx * 16
    poseRef.current.tiltRx = REST_RX - ny * 12
    poseRef.current.tiltTx = nx * 14
    poseRef.current.tiltTy = ny * 10
    commitPose()
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    unlockSensorsOnGesture()
    dragPointerRef.current = event.pointerId
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
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    poseRef.current.tiltRy = REST_RY
    poseRef.current.tiltRx = REST_RX
    poseRef.current.tiltTx = 0
    poseRef.current.tiltTy = 0
    commitPose()
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
          blobScale={0.95}
          className={styles.typewriter}
        />
      ) : null}
    </div>
  )
}
