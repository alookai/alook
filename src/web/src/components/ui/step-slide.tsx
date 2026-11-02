"use client"

import { Component, createRef, type ReactNode } from "react"

type Props = { step: string; order: number; children: ReactNode; className?: string; testId?: string }
type Snapshot = { previous: HTMLElement | null; forward: boolean; restoreFocus: boolean } | null

export class StepSlide extends Component<Props> {
  private viewport = createRef<HTMLDivElement>()
  private content = createRef<HTMLDivElement>()
  private cleanup: (() => void) | undefined
  private observer: ResizeObserver | undefined
  private resizeAnimation: Animation | undefined
  private resizeFrame: number | undefined
  private stopResize = () => {
    this.resizeAnimation?.cancel()
    this.resizeAnimation = undefined
    if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame)
    this.resizeFrame = undefined
  }
  private targetHeight: number | undefined
  private motion: MediaQueryList | undefined
  private reduceMotion = () => {
    if (this.motion?.matches) this.stopResize()
  }

  private resize = () => {
    const viewport = this.viewport.current
    const content = this.content.current
    if (!viewport || !content) return
    const style = getComputedStyle(viewport)
    const height = content.getBoundingClientRect().height + [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth].reduce((total, value) => total + (parseFloat(value) || 0), 0)
    if (height === this.targetHeight) return
    const from = viewport.getBoundingClientRect().height
    const initialized = this.targetHeight !== undefined
    this.targetHeight = height
    this.stopResize()
    viewport.style.height = `${height}px`
    if (!initialized || Math.abs(from - height) < 0.5 || !viewport.animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const animation = viewport.animate([{ height: `${from}px` }, { height: `${height}px` }], { duration: 500, easing: "ease-in-out" })
    this.resizeAnimation = animation
    animation.pause()
    let elapsed = 0
    let previous = performance.now()
    const finish = () => { if (this.resizeAnimation === animation) this.stopResize() }
    const advance = (now: number) => {
      elapsed = Math.min(500, elapsed + Math.min(32, Math.max(0, now - previous)))
      previous = now
      animation.currentTime = elapsed
      if (elapsed < 500) this.resizeFrame = requestAnimationFrame(advance)
      else finish()
    }
    animation.onfinish = finish
    this.resizeFrame = requestAnimationFrame(advance)
  }

  componentDidMount() {
    this.motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    this.motion.addEventListener("change", this.reduceMotion)
    this.resize()
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(this.resize)
      this.observer.observe(this.content.current!)
    }
  }

  getSnapshotBeforeUpdate(previous: Props): Snapshot {
    if (previous.step === this.props.step) return null
    this.cleanup?.()
    const content = this.content.current
    if (!content) return null
    const restoreFocus = content.contains(document.activeElement)
    if (restoreFocus && document.activeElement instanceof HTMLElement) document.activeElement.blur()
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !content.animate) return { previous: null, forward: true, restoreFocus }
    const clone = content.cloneNode(true) as HTMLElement
    const computed = getComputedStyle(content)
    for (const property of computed) {
      if (property.startsWith("--")) clone.style.setProperty(property, computed.getPropertyValue(property))
    }
    clone.style.color = computed.color
    clone.inert = true
    clone.setAttribute("aria-hidden", "true")
    clone.removeAttribute("id")
    clone.querySelectorAll("[id], [data-testid]").forEach(element => { element.removeAttribute("id"); element.removeAttribute("data-testid") })
    return { previous: clone, forward: this.props.order >= previous.order, restoreFocus }
  }

  componentDidUpdate(_previous: Props, _state: unknown, snapshot: Snapshot) {
    this.resize()
    if (!snapshot) return
    const viewport = this.viewport.current!
    const content = this.content.current!
    const { previous, forward, restoreFocus } = snapshot
    const focusHeading = () => {
      if (!restoreFocus) return
      const heading = content.querySelector("h2")
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }) }
    }
    if (!previous) { focusHeading(); return }
    previous.style.position = "absolute"
    previous.style.inset = "auto"
    previous.style.left = `${content.offsetLeft}px`
    previous.style.top = `${content.offsetTop}px`
    previous.style.width = `${content.offsetWidth}px`
    viewport.appendChild(previous)
    content.inert = true
    viewport.dataset.transitioning = "true"
    const timing = { duration: 500, easing: "ease-in-out" }
    const incoming = content.animate([{ transform: `translateX(${forward ? "100%" : "-100%"})` }, { transform: "translateX(0)" }], timing)
    const outgoing = previous.animate([{ transform: "translateX(0)" }, { transform: `translateX(${forward ? "-100%" : "100%"})` }], timing)
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const finish = () => {
      this.cleanup?.()
      focusHeading()
    }
    this.cleanup = () => {
      incoming.onfinish = null
      incoming.cancel(); outgoing.cancel()
      previous.remove()
      content.inert = false
      delete viewport.dataset.transitioning
      query.removeEventListener("change", finish)
      this.cleanup = undefined
    }
    query.addEventListener("change", finish)
    incoming.onfinish = finish
  }

  componentWillUnmount() { this.cleanup?.(); this.observer?.disconnect(); this.stopResize(); this.motion?.removeEventListener("change", this.reduceMotion) }

  render() {
    return <div ref={this.viewport} data-testid={this.props.testId} className={`relative min-h-0 overflow-hidden ${this.props.className ?? ""}`}>
      <div ref={this.content}>{this.props.children}</div>
    </div>
  }
}
