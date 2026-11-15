"use client"

import { useLayoutEffect, useMemo, useRef, type HTMLAttributes, type PointerEvent, type Ref } from "react"
import { composeRefs } from "@videojs/react"
import { projectSliderPointer, type PlayerRotation } from "./video-orientation"

export function renderOrientedSlider(props: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }, rotation: PlayerRotation) {
  if (rotation === 0) return <div {...props} />
  const adapt = (handler: ((event: PointerEvent<HTMLDivElement>) => void) | undefined) =>
    handler ? (event: PointerEvent<HTMLDivElement>) => handler(projectSliderPointer(event, rotation)) : undefined
  return <div {...props}
    onPointerDown={adapt(props.onPointerDown)}
    onPointerMove={adapt(props.onPointerMove)}
    onPointerUp={adapt(props.onPointerUp)} />
}

type PopupProps = HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }

export function renderOrientedPopup(props: PopupProps, rotation: PlayerRotation, side: "top" | "right") {
  return <OrientedPopup popupProps={props} rotation={rotation} side={side} />
}

function OrientedPopup({ popupProps, rotation, side }: { popupProps: PopupProps; rotation: PlayerRotation; side: "top" | "right" }) {
  const popupRef = useRef<HTMLDivElement>(null)
  const ref = useMemo(() => composeRefs(popupProps.ref, popupRef), [popupProps.ref])
  const nativePopover = typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype
  useLayoutEffect(() => {
    if (rotation === 0) return
    const popup = popupRef.current
    const player = popup?.closest<HTMLElement>(".alook-video-player")
    const anchor = popup?.parentElement?.querySelector("button")
    if (!popup || !player || !anchor) return
    const position = () => {
      const bounds = player.getBoundingClientRect(), trigger = anchor.getBoundingClientRect()
      const rad = rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad)
      const centerX = bounds.left + bounds.width / 2, centerY = bounds.top + bounds.height / 2
      const dx = trigger.left + trigger.width / 2 - centerX, dy = trigger.top + trigger.height / 2 - centerY
      const anchorX = cos * dx + sin * dy + player.offsetWidth / 2
      const anchorY = -sin * dx + cos * dy + player.offsetHeight / 2
      const width = popup.offsetWidth, height = popup.offsetHeight
      const localX = side === "right" ? anchorX + trigger.height / 2 + 8 + width / 2 : anchorX + trigger.height / 2 - width / 2
      const localY = side === "top" ? anchorY - trigger.width / 2 - 8 - height / 2 : anchorY
      const rawX = cos * (localX - player.offsetWidth / 2) - sin * (localY - player.offsetHeight / 2) + centerX
      const rawY = sin * (localX - player.offsetWidth / 2) + cos * (localY - player.offsetHeight / 2) + centerY
      const x = Math.max(bounds.left + height / 2 + 4, Math.min(bounds.right - height / 2 - 4, rawX))
      const y = Math.max(bounds.top + width / 2 + 4, Math.min(bounds.bottom - width / 2 - 4, rawY))
      const parent = popup.parentElement!
      const parentBounds = parent.getBoundingClientRect()
      const parentX = parentBounds.left + parentBounds.width / 2, parentY = parentBounds.top + parentBounds.height / 2
      const left = nativePopover ? x - width / 2 : cos * (x - parentX) + sin * (y - parentY) + parent.offsetWidth / 2 - width / 2
      const top = nativePopover ? y - height / 2 : -sin * (x - parentX) + cos * (y - parentY) + parent.offsetHeight / 2 - height / 2
      popup.style.setProperty("--alook-popup-left", `${left}px`)
      popup.style.setProperty("--alook-popup-top", `${top}px`)
    }
    position()
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position)
    for (const element of [popup, player, anchor]) observer?.observe(element)
    window.addEventListener("resize", position)
    window.addEventListener("scroll", position, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", position)
      window.removeEventListener("scroll", position, true)
    }
  }, [rotation, side, nativePopover])
  return <div {...popupProps} ref={ref} data-oriented-popup={rotation === 0 ? undefined : ""} data-native-oriented-popup={rotation !== 0 && nativePopover ? "" : undefined} />
}
