export type StabilitySurfaceKind = "text" | "dm" | "thread" | "forum-post" | "forum-list"

export type StabilityShiftSample = Readonly<{
  id: string
  deltaPx: number
  phase: string
  frame: number
}>

export type StabilityScenarioMetrics = Readonly<{
  scenario: string
  surface: StabilitySurfaceKind
  channelId: string
  remountCount: number
  scrollerRemounts: number
  contentRemounts: number
  skeletonReappearanceCount: number
  skeletonMaskFrames: number
  maxRafVisibleRowShiftPx: number
  framesSampled: number
  topShifts: readonly StabilityShiftSample[]
}>

export type StabilityThresholdCheck = Readonly<{
  passed: boolean
  violations: readonly string[]
}>

export const STABILITY_THRESHOLDS = {
  maxRemountCount: 0,
  maxSkeletonReappearanceCount: 0,
  maxRafVisibleRowShiftPx: 1,
} as const

export function evaluateStabilityThresholds(
  scenarios: readonly StabilityScenarioMetrics[],
): StabilityThresholdCheck {
  const violations: string[] = []
  for (const scenario of scenarios) {
    if (scenario.remountCount > STABILITY_THRESHOLDS.maxRemountCount) {
      violations.push(
        `${scenario.scenario}: remountCount=${scenario.remountCount} (expected <= ${STABILITY_THRESHOLDS.maxRemountCount})`,
      )
    }
    if (scenario.skeletonReappearanceCount > STABILITY_THRESHOLDS.maxSkeletonReappearanceCount) {
      violations.push(
        `${scenario.scenario}: skeletonReappearanceCount=${scenario.skeletonReappearanceCount} (expected <= ${STABILITY_THRESHOLDS.maxSkeletonReappearanceCount})`,
      )
    }
    if (scenario.maxRafVisibleRowShiftPx > STABILITY_THRESHOLDS.maxRafVisibleRowShiftPx) {
      violations.push(
        `${scenario.scenario}: maxRafVisibleRowShiftPx=${scenario.maxRafVisibleRowShiftPx} (expected <= ${STABILITY_THRESHOLDS.maxRafVisibleRowShiftPx})`,
      )
    }
  }
  return {
    passed: violations.length === 0,
    violations,
  }
}

export const STABILITY_PROBE_INIT_SCRIPT = `(() => {
  const GLOBAL_KEY = "__alookMessageAreaStabilityProbe"
  if (window[GLOBAL_KEY]) return

  let active = null

  const round = (value) => Math.round(value * 1000) / 1000

  const resolveNodes = (state) => {
    const scopeRoot = state.scopeSelector ? document.querySelector(state.scopeSelector) : document
    if (!scopeRoot) return { container: null, scroller: null, content: null }
    if (state.surface === "forum-list") {
      const scroller = scopeRoot.querySelector('[data-testid="community-forum-post-list"]')
      const container = scroller ? scroller.parentElement : scopeRoot
      const content = scroller ? scroller.querySelector("[data-message-list-content]") : null
      return { container, scroller, content }
    }
    const surface = scopeRoot.querySelector(
      '[data-slot="community-conversation-surface"][data-channel-id="' + state.channelId + '"]',
    )
    const scroller = surface ? surface.querySelector('[data-testid="community-message-scroller"]') : null
    const content = scroller ? scroller.querySelector("[data-message-list-content]") : null
    return { container: surface, scroller, content }
  }

  const isRowVisible = (content, row, scrollerRect) => {
    if (!content || !row) return false
    const style = window.getComputedStyle(content)
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
      return false
    }
    const rect = row.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom
  }

  const hasMaskActive = (state, container, scroller, content) => {
    if (state.surface === "forum-list") {
      if (!container) return false
      if (container.querySelector('[data-forum-positioning-skeleton], [aria-label="Loading forum"]')) {
        return true
      }
      if (scroller && scroller.getAttribute("aria-busy") === "true") return true
      if (!content) return Boolean(scroller)
      if (content.getAttribute("aria-hidden") === "true" || content.hasAttribute("inert")) return true
      const style = window.getComputedStyle(content)
      if (style.visibility === "hidden") return true
      return false
    }
    if (!container) return false
    if (container.querySelector("[data-message-list-skeleton], [data-message-positioning-skeleton]")) {
      return true
    }
    if (!content) return Boolean(scroller)
    const style = window.getComputedStyle(content)
    if (style.visibility === "hidden") return true
    if (content.getAttribute("data-initial-position-phase") === "positioning") return true
    return false
  }

  const readVisibleRows = (state, scroller, content) => {
    const visibleNow = new Map()
    const scrollerRect = scroller.getBoundingClientRect()
    if (state.surface === "forum-list") {
      const cards = scroller.querySelectorAll('[data-page-swipe-navigation-row][data-testid^="community-forum-post-"]')
      for (const card of cards) {
        if (!isRowVisible(content, card, scrollerRect)) continue
        const id = card.getAttribute("data-testid")
        if (!id) continue
        const rect = card.getBoundingClientRect()
        visibleNow.set(id, round(rect.top - scrollerRect.top))
      }
      return visibleNow
    }
    const rows = scroller.querySelectorAll("[data-msg-id]")
    for (const row of rows) {
      if (!isRowVisible(content, row, scrollerRect)) continue
      const id = row.getAttribute("data-msg-id")
      if (!id) continue
      const rect = row.getBoundingClientRect()
      visibleNow.set(id, round(rect.top - scrollerRect.top))
    }
    return visibleNow
  }

  const sample = () => {
    if (!active) return
    const state = active
    state.framesSampled += 1
    const { container, scroller, content } = resolveNodes(state)

    if (scroller) {
      if (state.scrollerNode && state.scrollerNode !== scroller) {
        state.scrollerRemounts += 1
      }
      state.scrollerNode = scroller
    }
    if (content) {
      if (state.contentNode && state.contentNode !== content) {
        state.contentRemounts += 1
      }
      state.contentNode = content
    }

    const maskNow = hasMaskActive(state, container, scroller, content)
    if (maskNow) state.skeletonMaskFrames += 1

    const visibleNow = scroller && content && !maskNow
      ? readVisibleRows(state, scroller, content)
      : new Map()

    if (visibleNow.size > 0) {
      state.hasSeenVisibleRows = true
    }

    if (state.hasSeenVisibleRows) {
      if (maskNow && !state.wasMaskedAfterVisible) {
        state.skeletonReappearanceCount += 1
        state.wasMaskedAfterVisible = true
      } else if (!maskNow && visibleNow.size > 0) {
        state.wasMaskedAfterVisible = false
      }
    }

    if (state.measureShift && visibleNow.size > 0 && state.prevVisibleTops) {
      for (const [id, topRel] of visibleNow.entries()) {
        const prevTop = state.prevVisibleTops.get(id)
        if (prevTop === undefined) continue
        const deltaPx = round(Math.abs(topRel - prevTop))
        if (deltaPx > state.maxRafVisibleRowShiftPx) {
          state.maxRafVisibleRowShiftPx = deltaPx
        }
        if (deltaPx > 0.5) {
          state.shifts.push({
            id,
            deltaPx,
            phase: state.phase,
            frame: state.framesSampled,
          })
        }
      }
    }

    state.prevVisibleTops = visibleNow.size > 0 ? visibleNow : null
  }

  const loop = () => {
    if (!active) return
    sample()
    active.rafId = window.requestAnimationFrame(loop)
  }

  window[GLOBAL_KEY] = {
    start({ scenario, surface, channelId, scopeSelector = null, phase = "initial", measureShift = true }) {
      if (active) {
        this.stop()
      }
      const state = {
        scenario,
        surface,
        channelId,
        scopeSelector,
        phase,
        measureShift,
        scrollerNode: null,
        contentNode: null,
        scrollerRemounts: 0,
        contentRemounts: 0,
        hasSeenVisibleRows: false,
        wasMaskedAfterVisible: false,
        skeletonReappearanceCount: 0,
        skeletonMaskFrames: 0,
        maxRafVisibleRowShiftPx: 0,
        framesSampled: 0,
        prevVisibleTops: null,
        shifts: [],
        observer: null,
        rafId: 0,
      }
      const observer = new MutationObserver(() => {
        if (!active) return
        const { container, scroller, content } = resolveNodes(active)
        if (scroller) {
          if (active.scrollerNode && active.scrollerNode !== scroller) {
            active.scrollerRemounts += 1
          }
          active.scrollerNode = scroller
        }
        if (content) {
          if (active.contentNode && active.contentNode !== content) {
            active.contentRemounts += 1
          }
          active.contentNode = content
        }
        if (active.hasSeenVisibleRows) {
          const maskNow = hasMaskActive(active, container, scroller, content)
          if (maskNow && !active.wasMaskedAfterVisible) {
            active.skeletonReappearanceCount += 1
            active.wasMaskedAfterVisible = true
          }
        }
      })
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "data-initial-position-phase", "data-read-position-ready", "aria-hidden", "aria-busy", "inert"],
      })
      state.observer = observer
      active = state
      sample()
      state.rafId = window.requestAnimationFrame(loop)
    },

    setPhase(phase, measureShift = true) {
      if (!active) return
      active.phase = phase
      active.measureShift = measureShift
      active.prevVisibleTops = null
    },

    stop() {
      if (!active) return null
      const state = active
      active = null
      if (state.rafId) window.cancelAnimationFrame(state.rafId)
      if (state.observer) state.observer.disconnect()
      const topShifts = state.shifts
        .slice()
        .sort((left, right) => right.deltaPx - left.deltaPx)
        .slice(0, 8)
      return {
        scenario: state.scenario,
        surface: state.surface,
        channelId: state.channelId,
        remountCount: state.scrollerRemounts + state.contentRemounts,
        scrollerRemounts: state.scrollerRemounts,
        contentRemounts: state.contentRemounts,
        skeletonReappearanceCount: state.skeletonReappearanceCount,
        skeletonMaskFrames: state.skeletonMaskFrames,
        maxRafVisibleRowShiftPx: state.maxRafVisibleRowShiftPx,
        framesSampled: state.framesSampled,
        topShifts,
      }
    },
  }
})()`
