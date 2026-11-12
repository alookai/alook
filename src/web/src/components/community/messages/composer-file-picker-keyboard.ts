import { isTauri } from "@alook/shared"
import type { Editor } from "@tiptap/react"

type PickerCommand = { command: "capturePicker" | "restorePicker" | "cancelPicker"; token: string }
type PickerBridge = { postMessage: (command: PickerCommand) => Promise<{ captured?: boolean; restoring?: boolean }> }
type PickerWindow = Window & { webkit?: { messageHandlers?: { alookKeyboard?: PickerBridge } } }

export const COMPOSER_PICKER_RETURN_EVENT = "alook:composer-picker-return"

export function createComposerFilePickerKeyboard(
  editor: Editor | null,
  isCurrent: () => boolean,
  restore: () => void,
  readOwnerVersion: () => string = () => "",
) {
  let retire = () => {}
  return {
    retire: () => retire(),
    prepare: (input: HTMLInputElement) => {
      retire()
      if (!isTauri() || !editor || editor.isDestroyed || !editor.isFocused ||
        !editor.view.hasFocus() || !isCurrent()) return
      const bridge = (window as PickerWindow).webkit?.messageHandlers?.alookKeyboard
      if (!bridge) return
      const token = crypto.randomUUID()
      const { doc, selection } = editor.state
      const ownerVersion = readOwnerVersion()
      let live = true
      let returned = false
      let restoring = false
      const current = () => live && !editor.isDestroyed && isCurrent() && readOwnerVersion() === ownerVersion &&
        editor.view.dom.isConnected && editor.view.hasFocus() && editor.isFocused &&
        editor.state.doc === doc && editor.state.selection.eq(selection)
      const command = (command: PickerCommand["command"]) => {
        try { return Promise.resolve(bridge.postMessage({ command, token })).catch(() => undefined) }
        catch { return Promise.resolve(undefined) }
      }
      const onTakeover = () => close()
      const onVisibility = () => { if (document.visibilityState === "hidden") close() }
      const onFocus = (event: FocusEvent) => {
        if (!(event.target instanceof Node) || !editor.view.dom.contains(event.target)) close()
      }
      const onTransaction = () => { if (!current()) close() }
      const onNativeReturn = (event: Event) => {
        if ((event as CustomEvent<unknown>).detail !== token || !restoring) return
        const qualified = current() && returned
        close()
        if (qualified) restore()
      }
      const onReturn = () => {
        if (returned) return
        returned = true
        input.removeEventListener("cancel", onReturn)
        input.removeEventListener("change", onReturn)
        void captured.then((result) => {
          if (!current() || result?.captured !== true) { close(); return }
          restoring = true
          void command("restorePicker").then((response) => {
            if (live && response?.restoring !== true) close()
          })
        })
      }
      const close = () => {
        if (!live) return
        live = false
        input.removeEventListener("cancel", onReturn)
        input.removeEventListener("change", onReturn)
        window.removeEventListener("pointerdown", onTakeover, true)
        window.removeEventListener("keydown", onTakeover, true)
        window.removeEventListener("focusin", onFocus, true)
        window.removeEventListener("pagehide", onTakeover)
        document.removeEventListener("visibilitychange", onVisibility)
        window.removeEventListener(COMPOSER_PICKER_RETURN_EVENT, onNativeReturn)
        editor.off("transaction", onTransaction)
        void command("cancelPicker")
      }
      retire = close
      input.addEventListener("cancel", onReturn)
      input.addEventListener("change", onReturn)
      window.addEventListener("pointerdown", onTakeover, true)
      window.addEventListener("keydown", onTakeover, true)
      window.addEventListener("focusin", onFocus, true)
      window.addEventListener("pagehide", onTakeover)
      document.addEventListener("visibilitychange", onVisibility)
      window.addEventListener(COMPOSER_PICKER_RETURN_EVENT, onNativeReturn)
      editor.on("transaction", onTransaction)
      const captured = command("capturePicker")
      void captured.then((response) => { if (live && response?.captured !== true) close() })
    },
  }
}
