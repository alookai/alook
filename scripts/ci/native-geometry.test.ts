import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

const script = readFileSync(resolve(import.meta.dirname, "../../src/desktop/src-tauri/src/native_geometry.js"), "utf8")
const packet = (overrides: Record<string, unknown> = {}) => ({ top: 50, right: 20, bottom: 30, left: 10, viewportWidth: 1000, viewportHeight: 800, caption: false, ...overrides })
function target() {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>()
  return {
    addEventListener(type: string, callback: (event: Record<string, unknown>) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(callback)
    },
    fire(type: string, event: Record<string, unknown> = {}) { for (const callback of listeners.get(type) ?? []) callback(event) },
  }
}
function documentOwner(query: () => unknown = () => packet(), options: { android?: boolean; otherFrame?: boolean; noRoot?: boolean; desktop?: boolean; noBridge?: boolean; otherLabel?: boolean } = {}) {
  const values = new Map<string, string>([["color-scheme", "dark"]])
  const root = { dataset: {} as Record<string, string>, style: {
    setProperty: (name: string, value: string) => values.set(name, value), removeProperty: (name: string) => values.delete(name),
  } }
  const document = { ...target(), documentElement: options.noRoot ? null : root }
  const calls: string[] = []
  const postMessage = vi.fn(() => { calls.push('query'); return query() })
  const window = { ...target(), top: null as unknown, __TAURI__: { webview: { getCurrentWebview: () => ({ label: options.otherLabel ? 'splash' : 'main' }) }, core: { invoke: vi.fn((command: string) => { calls.push(command); return query() }) } },
    webkit: options.noBridge ? undefined : { messageHandlers: { alookGeometry: { postMessage } } },
    AlookNative: options.android ? { getGeometrySnapshot: () => JSON.stringify(query()) } : undefined,
    __alookNativeGeometry: undefined as undefined | { getSnapshot: () => { status: string; insets: ReturnType<typeof packet> | null }; subscribe: (callback: () => void) => () => void },
  }
  window.top = options.otherFrame ? {} : window
  const originalAdd = window.addEventListener
  window.addEventListener = (type, callback) => { calls.push(type); originalAdd(type, callback) }
  let observer: (() => void) | undefined
  runInNewContext(`(${script})(${options.desktop === true})`, { window, document, MutationObserver: class { constructor(callback: () => void) { observer = callback } observe() {} disconnect() {} } })
  return { window, document, root, values, calls, postMessage, attachRoot: () => { document.documentElement = root; observer?.() } }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('native document geometry publication', () => {
  it('subscribes before querying and atomically projects the original four edges', async () => {
    const owner = documentOwner()
    await settle()
    expect(owner.calls.indexOf('alook:geometry-change')).toBeLessThan(owner.calls.indexOf('query'))
    expect(owner.window.__alookNativeGeometry!.getSnapshot()).toEqual({ status: 'ready', insets: packet() })
    expect([...owner.values]).toEqual([['color-scheme', 'dark'], ['--app-safe-area-top', '5vw'], ['--app-safe-area-right', '2vw'], ['--app-safe-area-bottom', '3vw'], ['--app-safe-area-left', '1vw']])
    expect(owner.root.dataset).toEqual({ alookNativeGeometry: 'ready', alookNativeCaption: 'false' })
  })

  it.each(['right', 'bottom', 'left', 'viewportWidth', 'viewportHeight'])('publishes an isolated %s change without a top change', async key => {
    let next = packet()
    const owner = documentOwner(() => next)
    await settle()
    const listener = vi.fn()
    const unsubscribe = owner.window.__alookNativeGeometry!.subscribe(listener)
    next = packet({ [key]: 100 })
    owner.window.fire('alook:geometry-change')
    await settle()
    expect(owner.window.__alookNativeGeometry!.getSnapshot().insets).toEqual(next)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    owner.window.fire('alook:geometry-change')
    await settle()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('ignores old queries after newer changes and a resize while replies are pending', async () => {
    const replies: Array<(value: unknown) => void> = []
    const owner = documentOwner(() => new Promise(resolve => replies.push(resolve)))
    owner.window.fire('alook:geometry-change')
    owner.window.fire('resize')
    replies[2](packet({ top: 100, viewportWidth: 2000 }))
    await settle()
    replies[0](packet({ top: 0 }))
    replies[1](packet({ left: 0 }))
    await settle()
    expect(owner.window.__alookNativeGeometry!.getSnapshot().insets).toEqual(packet({ top: 100, viewportWidth: 2000 }))
    expect(owner.values.get('--app-safe-area-top')).toBe('5vw')
  })

  it.each([NaN, Infinity, -1, null, '10'])('keeps invalid edge %s distinct from measured zero', async value => {
    let next = packet()
    const owner = documentOwner(() => next)
    await settle()
    next = packet({ right: value })
    owner.window.fire('alook:geometry-change')
    await settle()
    expect(owner.window.__alookNativeGeometry!.getSnapshot()).toEqual({ status: 'error', insets: null })
    expect(owner.values.has('--app-safe-area-right')).toBe(false)
    next = packet({ top: 0, right: 0, bottom: 0, left: 0 })
    owner.window.fire('alook:geometry-change')
    await settle()
    expect(owner.window.__alookNativeGeometry!.getSnapshot().status).toBe('ready')
    expect(owner.values.get('--app-safe-area-right')).toBe('0vw')
  })

  it.each([{ viewportWidth: 0 }, { viewportHeight: Infinity }, { left: 999 }, { top: 800 }])('rejects inconsistent size/occlusion %j', async invalid => {
    const owner = documentOwner(() => packet(invalid))
    await settle()
    expect(owner.window.__alookNativeGeometry!.getSnapshot()).toEqual({ status: 'error', insets: null })
  })

  it('reports missing/rejected measurement and initializes an element created after injection', async () => {
    const missing = documentOwner(() => null)
    await settle()
    expect(missing.window.__alookNativeGeometry!.getSnapshot().status).toBe('error')
    const rejected = documentOwner(() => Promise.reject(new Error('unavailable')))
    await settle()
    expect(rejected.window.__alookNativeGeometry!.getSnapshot().insets).toBeNull()
    const delayedRoot = documentOwner(() => packet(), { noRoot: true })
    await settle()
    delayedRoot.attachRoot()
    expect(delayedRoot.values.get('--app-safe-area-bottom')).toBe('3vw')
  })

  it('retires callbacks on pagehide and queries current state on BFCache restoration', async () => {
    const replies: Array<(value: unknown) => void> = []
    const owner = documentOwner(() => new Promise(resolve => replies.push(resolve)))
    owner.window.fire('pagehide')
    owner.window.fire('alook:geometry-change')
    replies[0](packet())
    await settle()
    expect(owner.window.__alookNativeGeometry!.getSnapshot()).toEqual({ status: 'pending', insets: null })
    expect(replies).toHaveLength(1)
    owner.window.fire('pageshow', { persisted: true })
    replies[1](packet({ bottom: 0 }))
    await settle()
    expect(owner.window.__alookNativeGeometry!.getSnapshot().insets?.bottom).toBe(0)
  })

  it('reads the Android packet without converting density twice and leaves other frames alone', async () => {
    const android = documentOwner(() => packet({ viewportWidth: 2000, top: 100 }), { android: true })
    await settle()
    expect(android.values.get('--app-safe-area-top')).toBe('5vw')
    expect(android.postMessage).not.toHaveBeenCalled()
    const child = documentOwner(() => packet(), { otherFrame: true })
    expect(child.window.__alookNativeGeometry).toBeUndefined()
    expect(child.postMessage).not.toHaveBeenCalled()
  })

  it.each([[500, 25], [1000, 50], [2000, 100], [4000, 200]])('projects 100 native units to %i CSS viewport units as %i px across zoom/DPI', async (cssWidth, expected) => {
    const owner = documentOwner(() => packet({ top: 100, viewportWidth: 2000 }))
    await settle()
    const vw = Number.parseFloat(owner.values.get('--app-safe-area-top')!)
    expect(vw * cssWidth / 100).toBe(expected)
  })
})

it('uses the desktop read-only command for each document and keeps a missing mobile bridge pending', async () => {
  const desktop = documentOwner(() => packet({ caption: true }), { desktop: true, noBridge: true })
  await settle()
  expect(desktop.window.__TAURI__.core.invoke).toHaveBeenCalledExactlyOnceWith('native_geometry_snapshot')
  expect(desktop.root.dataset.alookNativeCaption).toBe('true')
  const mobile = documentOwner(() => packet(), { noBridge: true })
  await settle()
  expect(mobile.window.__alookNativeGeometry!.getSnapshot()).toEqual({ status: 'pending', insets: null })
  expect(mobile.window.__TAURI__.core.invoke).not.toHaveBeenCalled()
  expect(documentOwner(() => packet(), { otherLabel: true }).window.__alookNativeGeometry).toBeUndefined()
})

it('retains snapshot identity for unchanged complete geometry', async () => {
  const owner = documentOwner()
  await settle()
  const before = owner.window.__alookNativeGeometry!.getSnapshot()
  const subscriber = vi.fn()
  owner.window.__alookNativeGeometry!.subscribe(subscriber)
  owner.window.fire('alook:geometry-change')
  await settle()
  expect(owner.window.__alookNativeGeometry!.getSnapshot()).toBe(before)
  expect(subscriber).not.toHaveBeenCalled()
})

it('keeps geometry read-only and caption actions exclusive to macOS trusted main documents', () => {
  const nativeRoot = resolve(import.meta.dirname, '../../src/desktop/src-tauri')
  const readJson = (path: string) => JSON.parse(readFileSync(resolve(nativeRoot, path), 'utf8'))
  for (const development of [false, true]) {
    const suffix = development ? '-dev' : ''
    const urls = development ? ['http://localhost:3000'] : ['https://alook.ai', 'http://alook-recovery.localhost']
    const geometry = readJson(`capabilities/native-geometry${suffix}.json`)
    expect(geometry).toMatchObject({
      identifier: `native-geometry${suffix}`,
      windows: ['main'], local: !development,
      remote: { urls }, permissions: ['allow-native-geometry-snapshot'],
    })
    expect(geometry.platforms.toSorted()).toEqual(['linux', 'macOS', 'windows'].toSorted())
    const caption = readJson(`capabilities/native-caption${suffix}.json`)
    expect(caption).toMatchObject({
      identifier: `native-caption${suffix}`, windows: ['main'], platforms: ['macOS'], local: !development,
      remote: { urls },
    })
    expect(caption.permissions.toSorted()).toEqual(['core:window:allow-start-dragging', 'core:window:allow-internal-toggle-maximize'].toSorted())
  }
  const release = readJson('tauri.conf.json').app.security.capabilities as unknown[]
  expect(release).toContain('native-geometry')
  expect(release).toContain('native-caption')
  expect(release).not.toContain('native-geometry-dev')
  expect(release).not.toContain('native-caption-dev')
})
