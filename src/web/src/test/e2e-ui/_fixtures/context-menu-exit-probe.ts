import type { Locator, Page } from "@playwright/test"

type ExitFocusSample = { popupMountedAtAction: boolean; popupClosingAtAction: boolean; editorFocusedAfterAction: boolean }
type ExitProbeWindow = Window & { __contextMenuExitFocusProbe?: { sample: ExitFocusSample | null; dispose: () => void } }

export async function focusEditorDuringContextMenuExit(page: Page, editor: Locator) {
  await editor.evaluate(element => {
    const state = window as ExitProbeWindow
    const popup = document.querySelector('[data-slot="context-menu-content"][data-open]')
    if (!popup || state.__contextMenuExitFocusProbe) throw new Error("Expected one open context menu and no exit probe")
    const probe = { sample: null as ExitFocusSample | null, dispose: (): void => undefined }
    let outsidePressed = false
    let actionTimer: ReturnType<typeof setTimeout> | undefined
    const actAtExit = () => {
      if (!outsidePressed || probe.sample || !popup.isConnected || !popup.hasAttribute("data-closed")) return
      const phase = { popupMountedAtAction: popup.isConnected, popupClosingAtAction: popup.hasAttribute("data-closed") }
      ;(element as HTMLElement).focus()
      probe.sample = { ...phase, editorFocusedAfterAction: document.activeElement === element }
      probe.dispose()
    }
    const scheduleExitAction = () => {
      if (!outsidePressed || probe.sample || actionTimer !== undefined || !popup.isConnected || !popup.hasAttribute("data-closed")) return
      actionTimer = setTimeout(() => { actionTimer = undefined; actAtExit() })
    }
    const outsidePress = (event: PointerEvent) => {
      if (event.button !== 0) return
      if (event.target instanceof Node && popup.contains(event.target)) return
      outsidePressed = true
      scheduleExitAction()
    }
    const observer = new MutationObserver(scheduleExitAction)
    probe.dispose = () => {
      observer.disconnect()
      document.removeEventListener("pointerdown", outsidePress, true)
      if (actionTimer !== undefined) clearTimeout(actionTimer)
    }
    document.addEventListener("pointerdown", outsidePress, true)
    state.__contextMenuExitFocusProbe = probe
    observer.observe(popup, { attributes: true, attributeFilter: ["data-closed"] })
  })
  return {
    read: () => page.evaluate(() => (window as ExitProbeWindow).__contextMenuExitFocusProbe?.sample ?? null),
    dispose: () => page.evaluate(() => {
      const state = window as ExitProbeWindow
      state.__contextMenuExitFocusProbe?.dispose()
      delete state.__contextMenuExitFocusProbe
    }),
  }
}
