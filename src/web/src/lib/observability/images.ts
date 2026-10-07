import { routeTemplate } from "./coverage"
import { imageSourceId, observationObjectId, imageCorrelationSnapshot, hasImageSource } from "./image-correlation"
import { emitImageTelemetry } from "./image-event-budget"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "./telemetry"
import type { Attributes } from "./schema"

let operationSequence = 0
let lastOperationAt = -Infinity

export type ImageSlot = "identity" | "content" | "markdown" | "lightbox_original" | "lightbox_thumbnail" | "thumbnail_prepare" | "crop" | "share" | "dom"
export type ImagePhase = "attach" | "detach" | "snapshot" | "source_change" | "presentation_change" | "effect_setup" | "effect_cleanup" | "eligible" | "timer_start" | "timer_clear" | "timeout" | "load" | "error" | "decode_start" | "decode_ready" | "decode_error" | "decode_unavailable" | "pixels_ready" | "state" | "ignored" | "retry" | "abort" | "encode_start" | "encode_ready" | "encode_error" | "stage_start" | "stage_ready" | "stage_error"

function imageFields(image?: HTMLImageElement | null): Attributes {
  if (!image) return {}
  const source = image.currentSrc || image.src
  const origin = typeof window === "undefined" ? "https://alook.ai" : window.location.origin
  return {
    image_node_id: observationObjectId(image), image_parent_id: image.parentElement ? observationObjectId(image.parentElement) : undefined,
    image_source_id: imageSourceId(source), declared_source_id: imageSourceId(image.src), route_template: routeTemplate(source, origin),
    connected: image.isConnected, complete: image.complete, natural_width: image.naturalWidth, natural_height: image.naturalHeight,
    image_parent: image.parentElement?.tagName === "BUTTON" ? "button" : image.parentElement ? "other" : "none",
    image_state: image.dataset?.remoteImageState, loading: image.loading === "lazy" ? "lazy" : "eager",
    image_element: "img", decode_supported: typeof image.decode === "function",
  }
}

export function observeImage(instance: object, slot: ImageSlot, imagePhase: ImagePhase, image?: HTMLImageElement | null, fields: Attributes | (() => Attributes) = {}) {
  if (!isTelemetryEligible()) return
  try {
    emitImageTelemetry("image.lifecycle", () => ({ ...imageFields(image), ...(typeof fields === "function" ? fields() : fields), ...imageCorrelationSnapshot(), image_instance_id: observationObjectId(instance), image_slot: slot, image_phase: imagePhase, operation_sequence: operationSequence, telemetry_generation: telemetryGeneration(), start_ms: performance.now(), time_origin_ms: performance.timeOrigin, capability: "limited" }))
  } catch {}
}

export function observeImageResource(resource: PerformanceResourceTiming): Attributes {
  const deliveryType = (resource as PerformanceResourceTiming & { deliveryType?: string }).deliveryType
  const isImage = resource.initiatorType === "img" || hasImageSource(resource.name) || /\.(?:png|jpe?g|webp|gif|svg|avif)(?:[?#]|$)/i.test(resource.name) || /\/api\/community\/.*\/(?:avatar|icon|thumbnail|attachments\/[^/?]+)(?:[?#]|$)/.test(resource.name)
  return {
    resource_id: observationObjectId(resource),
    image_source_id: isImage ? imageSourceId(resource.name) : undefined, ...(isImage ? imageCorrelationSnapshot() : {}), fetch_start_ms: resource.fetchStart, request_start_ms: resource.requestStart,
    response_start_ms: resource.responseStart, response_end_ms: resource.responseEnd, time_origin_ms: performance.timeOrigin,
    status: resource.responseStatus || undefined, delivery_type: deliveryType === "cache" ? "cache" : deliveryType === "navigational-prefetch" ? "prefetch" : "unknown",
  }
}

export function installImageObservers(active: () => boolean) {
  const record = (image: HTMLImageElement, phase: ImagePhase, parent?: Node) => { if (active()) observeImage(image, "dom", phase, image, () => ({ mutation_parent_id: parent ? observationObjectId(parent) : undefined })) }
  const recordSvg = (node: Element, phase: ImagePhase, parent?: Node) => {
    if (!active() || node.namespaceURI !== "http://www.w3.org/2000/svg" || node.localName !== "image") return
    const source = node.getAttribute("href") || node.getAttributeNS("http://www.w3.org/1999/xlink", "href") || undefined
    observeImage(node, "dom", phase, undefined, () => ({ image_element: "svg_image", image_node_id: observationObjectId(node), image_parent_id: node.parentElement ? observationObjectId(node.parentElement) : undefined, mutation_parent_id: parent ? observationObjectId(parent) : undefined, image_source_id: imageSourceId(source), route_template: routeTemplate(source ?? "", window.location.origin), connected: node.isConnected }))
  }
  const each = (node: Node, phase: ImagePhase, parent?: Node, seen = new Set<Element>()) => {
    if (node instanceof Element) {
      for (const image of [node, ...node.querySelectorAll("img,image")]) {
        if (seen.has(image)) continue
        seen.add(image)
        if (image instanceof HTMLImageElement) record(image, phase, parent)
        else recordSvg(image, phase, parent)
      }
    }
  }
  const event = (event: Event) => {
    if (event.target instanceof HTMLImageElement) record(event.target, event.type === "load" ? "load" : "error")
    else if (event.target instanceof Element) recordSvg(event.target, event.type === "load" ? "load" : "error")
  }
  document.addEventListener("load", event, true)
  document.addEventListener("error", event, true)
  const operation = (event: Event) => {
    if (!active()) return
    const now = performance.now()
    if (["scroll", "pointerover"].includes(event.type) && now - lastOperationAt < 100) return
    lastOperationAt = now
    operationSequence++
    emitImageTelemetry("image.operation", () => ({ image_operation: event.type, operation_sequence: operationSequence, operation_target_id: event.target && typeof event.target === "object" ? observationObjectId(event.target) : undefined, operation_key: event instanceof KeyboardEvent ? event.shiftKey && event.key === "F10" ? "shift_f10" : event.key === "ContextMenu" ? "context_menu" : "other" : undefined, start_ms: now, time_origin_ms: performance.timeOrigin, capability: "limited" }))
  }
  const operations = ["click", "pointerover", "focusin", "keydown", "scroll", "resize", "online"]
  for (const type of operations) window.addEventListener(type, operation, { capture: true, passive: true })
  each(document.documentElement, "snapshot")
  let observer: MutationObserver | undefined
  try {
    observer = new MutationObserver(records => {
      if (!active()) return
      const detached = new Set<Element>(), attached = new Set<Element>()
      for (const mutation of records) {
        if (mutation.type === "childList") {
          for (const node of mutation.removedNodes) each(node, "detach", mutation.target, detached)
          for (const node of mutation.addedNodes) each(node, "attach", mutation.target, attached)
        } else if (mutation.target instanceof HTMLImageElement) record(mutation.target, ["src", "srcset", "sizes"].includes(mutation.attributeName ?? "") ? "source_change" : "presentation_change")
        else if (mutation.target instanceof Element) recordSvg(mutation.target, "source_change")
      }
    })
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset", "sizes", "href", "xlink:href", "data-remote-image-state"] })
  } catch { emitTelemetry("telemetry.coverage", { capability: "unavailable", image_slot: "dom" }) }
  return () => { observer?.disconnect(); document.removeEventListener("load", event, true); document.removeEventListener("error", event, true); for (const type of operations) window.removeEventListener(type, operation, true) }
}
