desktop => {
  if (window.top !== window) return
  const install = () => {
    if (window.__alookNativeGeometry) return true
    const api = window.__TAURI__
    if (typeof api?.webview?.getCurrentWebview !== 'function') return false
    if (api.webview.getCurrentWebview().label !== 'main') return true
    const edges = ['top', 'right', 'bottom', 'left']
    const retryDelays = [50, 150, 300, 600, 1000]
    const subscribers = new Set()
    let state = Object.freeze({ status: 'pending', insets: null })
    let revision = 0
    let active = true
    let retryTimer
    let retryIndex = 0
    const clearRetry = () => {
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer)
        retryTimer = undefined
      }
    }
    const scheduleRetry = () => {
      if (!active || retryIndex >= retryDelays.length) return
      clearRetry()
      const delay = retryDelays[retryIndex++]
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined
        void sync(false)
      }, delay)
    }
    const valid = value => value && typeof value.caption === 'boolean'
      && ['viewportWidth', 'viewportHeight'].every(key => Number.isFinite(value[key]) && value[key] > 0)
      && edges.every(key => Number.isFinite(value[key]) && value[key] >= 0 && Number.isFinite(value[key] / value.viewportWidth * 100))
      && value.left + value.right <= value.viewportWidth
      && value.top + value.bottom <= value.viewportHeight
      && (value.windowHeight === undefined && value.windowBottom === undefined
        || Number.isFinite(value.windowHeight) && value.windowHeight >= value.viewportHeight
          && Number.isFinite(value.windowBottom) && value.windowBottom >= 0 && value.windowBottom <= value.windowHeight
          && Number.isFinite(value.windowHeight / value.viewportWidth * 100))
    const project = () => {
      const root = document.documentElement
      if (!root) return
      root.dataset.alookNativeGeometry = state.status
      for (const edge of edges) {
        if (state.insets) root.style.setProperty('--app-safe-area-' + edge, `${state.insets[edge] / state.insets.viewportWidth * 100}vw`)
        else root.style.removeProperty('--app-safe-area-' + edge)
      }
      root.dataset.alookNativeCaption = String(state.insets?.caption === true)
      const hasWindow = state.insets?.windowHeight !== undefined
      if (hasWindow) root.dataset.alookNativeResize = 'true'
      else delete root.dataset.alookNativeResize
      for (const [field, property] of [['windowHeight', '--app-native-window-height'], ['windowBottom', '--app-native-window-safe-bottom']]) {
        if (hasWindow) root.style.setProperty(property, `${state.insets[field] / state.insets.viewportWidth * 100}vw`)
        else root.style.removeProperty(property)
      }
    }
    const publish = (status, insets = null) => {
      if (state.status === status && state.insets === insets) return
      state = Object.freeze({ status, insets })
      project()
      for (const subscriber of subscribers) subscriber()
    }
    const fail = () => {
      publish('error', state.insets)
      scheduleRetry()
    }
    const accept = value => {
      if (!valid(value)) { fail(); return }
      clearRetry()
      retryIndex = 0
      const keys = [...edges, 'viewportWidth', 'viewportHeight', 'caption']
      if (value.windowHeight !== undefined) keys.push('windowHeight', 'windowBottom')
      if (state.status === 'ready' && keys.every(key => state.insets[key] === value[key])
        && (state.insets.windowHeight === undefined) === (value.windowHeight === undefined)) return
      const insets = Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])))
      publish('ready', insets)
    }
    const sync = async (resetRetry = true) => {
      if (!active) return
      clearRetry()
      if (resetRetry) retryIndex = 0
      const request = ++revision
      try {
        let value
        if (window.__alookNativeBridge?.getGeometrySnapshot) {
          const raw = window.__alookNativeBridge.getGeometrySnapshot()
          value = typeof raw === 'string' ? JSON.parse(raw) : raw
        }
        else if (window.webkit?.messageHandlers?.alookGeometry) value = await window.webkit.messageHandlers.alookGeometry.postMessage('snapshot')
        else if (desktop && window.__TAURI__?.core?.invoke) value = await window.__TAURI__.core.invoke('native_geometry_snapshot')
        else return
        if (active && request === revision) accept(value)
      } catch {
        if (active && request === revision) fail()
      }
    }
    window.__alookNativeGeometry = Object.freeze({
      getSnapshot: () => state,
      subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback) },
    })
    const change = () => { void sync(true) }
    window.addEventListener('alook:geometry-change', change)
    window.addEventListener('resize', change)
    window.addEventListener('pagehide', () => { active = false; revision++; clearRetry(); retryIndex = 0; publish('pending') })
    window.addEventListener('pageshow', event => { if (event.persisted) { active = true; void sync(true) } })
    document.addEventListener('DOMContentLoaded', () => { project(); void sync(true) }, { once: true })
    if (!document.documentElement) {
      const observer = new MutationObserver(() => {
        if (document.documentElement) { project(); observer.disconnect() }
      })
      observer.observe(document, { childList: true })
    }
    project()
    window.dispatchEvent(new Event('alook:geometry-ready'))
    void sync(true)
    return true
  }
  if (install()) return
  let active = true
  let timer
  const attempt = () => { if (active && install()) release() }
  const hide = () => { active = false; window.clearTimeout(timer) }
  const show = event => { if (event.persisted) { active = true; attempt() } }
  const release = () => {
    window.clearTimeout(timer)
    document.removeEventListener('DOMContentLoaded', attempt)
    window.removeEventListener('pagehide', hide)
    window.removeEventListener('pageshow', show)
  }
  document.addEventListener('DOMContentLoaded', attempt, { once: true })
  window.addEventListener('pagehide', hide)
  window.addEventListener('pageshow', show)
  timer = window.setTimeout(attempt, 0)
}
