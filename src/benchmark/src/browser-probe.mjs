export function installBrowserProbe({ messageSelector, submitSelector, composerSelector, submitAction, idAttribute, optimisticPrefix }) {
  let active
  function now() { return performance.timeOrigin + performance.now() }
  function visible(element) {
    if (document.visibilityState !== 'visible' || !element.isConnected) return false
    const rect = element.getBoundingClientRect()
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top)
    let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom)
    for (let parent = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
      if (parent !== element && /(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowX + style.overflowY)) {
        const clip = parent.getBoundingClientRect()
        left = Math.max(left, clip.left); right = Math.min(right, clip.right)
        top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom)
      }
    }
    if (right - left < 1 || bottom - top < 1) return false
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
    return hit !== null && (element.contains(hit) || hit.contains(element))
  }
  function scan() {
    if (!active) return
    for (const row of document.querySelectorAll(messageSelector)) {
      if (!row.textContent?.includes(active.text) || !visible(row)) continue
      const id = row.getAttribute(idAttribute)
      if (!id) continue
      const state = active
      if (state.visibleMs === null) {
        state.visibleMs = now()
        state.firstId = id

      }
      if (state.nextFrameMs === null) requestAnimationFrame(() => { if (active === state && visible(row)) state.nextFrameMs ??= now() })
      if (!id.startsWith(optimisticPrefix) && state.canonicalMs === null) {
        state.canonicalMs = now(); state.messageId = id
      }
    }
  }
  const observer = new MutationObserver(scan)
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  addEventListener('scroll', scan, true)
  addEventListener('resize', scan)
  addEventListener('click', event => {
    if (active && event.target instanceof Element && event.target.closest(submitSelector)) { active.clickMs ??= now(); active.eventType = event.type; active.isTrusted = event.isTrusted }
  }, true)
  addEventListener('keydown', event => {
    if (active && submitAction === 'enter' && event.key === 'Enter' && !event.shiftKey && event.target instanceof Element && event.target.closest(composerSelector)) { active.clickMs ??= now(); active.eventType = event.type; active.isTrusted = event.isTrusted }
  }, true)
  window.__BENCHMARK_PROBE__ = {
    arm(text) { active = { text, visibilityState: document.visibilityState, timeOrigin: performance.timeOrigin, eventType: null, isTrusted: null, clickMs: null, visibleMs: null, nextFrameMs: null, canonicalMs: null, messageId: null, firstId: null } },
    snapshot() { if (!active) return null; const { text, ...result } = active; return result },
    freeze() { const result = this.snapshot(); active = undefined; return result },
    stop() { active = undefined },
  }
}

export async function syncPageClock(page, attempts = 7) {
  let best
  for (let i = 0; i < attempts; i++) {
    const before = performance.now()
    const browser = await page.evaluate(() => performance.timeOrigin + performance.now())
    const after = performance.now()
    const sample = { offsetMs: (before + after) / 2 - browser, uncertaintyMs: (after - before) / 2, roundTripMs: after - before }
    if (!best || sample.roundTripMs < best.roundTripMs) best = sample
  }
  return best
}

export function metricDelta(before, after, name, multiplier = 1) {
  const a = before[name], b = after[name]
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) * multiplier : null
}
