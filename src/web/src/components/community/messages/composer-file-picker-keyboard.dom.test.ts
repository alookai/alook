import { Editor } from "@tiptap/react"
import { Component, createElement, createRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { composerDocumentExtensions } from "./composer-ordered-list"
import { createComposerFilePickerKeyboard, COMPOSER_PICKER_RETURN_EVENT } from "./composer-file-picker-keyboard"
import { createComposerAttachmentInputHandlers } from "./composer-file-utils"

const originals = new Map(["webkit", "__TAURI__"].map((key) => [key, Object.getOwnPropertyDescriptor(window, key)]))
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(window, key, descriptor)
    else Reflect.deleteProperty(window, key)
  }
})

type Command = { command: string; token: string }
function install(postMessage: (command: Command) => Promise<unknown>) {
  Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
  Object.defineProperty(window, "webkit", { configurable: true, value: { messageHandlers: { alookKeyboard: { postMessage } } } })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}
type FixtureState = {
  editor: Editor
  input: HTMLInputElement
  outside: HTMLButtonElement
  owner: ReturnType<typeof createComposerFilePickerKeyboard>
}
class EditorFixture extends Component<{
  onReady: (value: FixtureState) => void
  isCurrent: () => boolean
  restore: () => void
  readOwnerVersion?: () => string
}> {
  private host = createRef<HTMLDivElement>()
  private fileInput = createRef<HTMLInputElement>()
  private outsideButton = createRef<HTMLButtonElement>()
  private editor: Editor | null = null
  private owner: FixtureState["owner"] | null = null

  componentDidMount() {
    const element = this.host.current, input = this.fileInput.current, outside = this.outsideButton.current
    if (!element || !input || !outside) throw new Error("Picker fixture must be mounted")
    const editor = new Editor({ element, extensions: composerDocumentExtensions(false), content: "<p>alpha beta gamma</p>",
      editorProps: { handleScrollToSelection: () => true } })
    this.editor = editor
    editor.commands.setTextSelection({ from: 6, to: 10 })
    editor.view.focus()
    const owner = createComposerFilePickerKeyboard(editor, this.props.isCurrent, () => {
      this.props.restore()
      editor.view.dom.blur()
      editor.view.focus()
    }, this.props.readOwnerVersion)
    this.owner = owner
    this.props.onReady({ editor, input, outside, owner })
  }

  componentWillUnmount() {
    this.owner?.retire()
    this.editor?.destroy()
  }

  render() {
    return createElement("section", null,
      createElement("div", { ref: this.host }),
      createElement("input", { type: "file", ref: this.fileInput }),
      createElement("button", { type: "button", ref: this.outsideButton }, "Outside"),
    )
  }
}
function fixture(readOwnerVersion?: () => string) {
  let current = true
  const restore = vi.fn()
  const ready = vi.fn<(value: FixtureState) => void>()
  const view = render(createElement(EditorFixture, { onReady: ready, isCurrent: () => current, restore, readOwnerVersion }))
  const mounted = ready.mock.calls[0]?.[0]
  if (!mounted) throw new Error("Expected mounted picker fixture")
  return { ...mounted, restore, doc: mounted.editor.getJSON(), selection: mounted.editor.state.selection.toJSON(),
    leave: () => { current = false }, unmount: view.unmount }
}
function returnToken(token: string) {
  act(() => { window.dispatchEvent(new CustomEvent(COMPOSER_PICKER_RETURN_EVENT, { detail: token })) })
}

function blurMetadataWithDOMFocus(editor: Editor) {
  const doc = editor.state.doc, selection = editor.state.selection
  const event = new FocusEvent("blur", { relatedTarget: null })
  const transactions: { event: unknown; docChanged: boolean; focused: boolean; domFocused: boolean }[] = []
  const onTransaction = ({ transaction }: { transaction: Editor["state"]["tr"] }) => {
    const blur = transaction.getMeta("blur") as { event: FocusEvent } | undefined
    if (blur) transactions.push({ event: blur.event, docChanged: transaction.docChanged,
      focused: editor.isFocused, domFocused: editor.view.hasFocus() })
  }
  editor.on("transaction", onTransaction)
  act(() => { editor.view.dom.dispatchEvent(event) })
  editor.off("transaction", onTransaction)
  expect(transactions).toEqual([{ event, docChanged: false, focused: false, domFocused: true }])
  expect(transactions[0].event).toBe(event)
  expect(editor.state.doc).toBe(doc)
  expect(editor.state.selection.eq(selection)).toBe(true)
  expect(document.activeElement).toBe(editor.view.dom)
  expect(editor.view.hasFocus()).toBe(true)
  expect(editor.isFocused).toBe(false)
}

describe("qualified native composer file-picker return", () => {
  it.each(["cancel", "change"])("requests restoration after a real blur-metadata transaction, preserving native denial on %s", async (event) => {
    const capture = deferred<{ captured: boolean }>(), restoration = deferred<{ restoring: boolean }>()
    const post = vi.fn((command: Command) => command.command === "capturePicker" ? capture.promise
      : command.command === "restorePicker" ? restoration.promise : Promise.resolve({ restoring: false }))
    install(post)
    const f = fixture()
    act(() => { f.editor.commands.setTextSelection(7) })
    f.owner.prepare(f.input)
    const token = post.mock.calls[0][0].token
    capture.resolve({ captured: true })
    await flush()
    blurMetadataWithDOMFocus(f.editor)
    f.input.dispatchEvent(new Event(event))
    await flush()
    expect(post).toHaveBeenCalledWith({ command: "restorePicker", token })
    expect(f.restore).not.toHaveBeenCalled()
    restoration.resolve({ restoring: false })
    await flush()
    returnToken(token)
    expect(f.restore).not.toHaveBeenCalled()
    expect(post.mock.calls.filter(([command]) => command.command === "restorePicker")).toHaveLength(1)
    expect(f.editor.getJSON()).toEqual(f.doc)
    expect(f.editor.state.selection.from).toBe(7)
    expect(f.editor.state.selection.to).toBe(7)
  })

  it.each(["DOM blur", "doc edit and undo", "caret move and return", "owner version"])("still retires after %s with blur metadata and preserved DOM focus", async (takeover) => {
    const post = vi.fn(async (_command: Command) => ({ captured: true, restoring: false }))
    install(post)
    let version = "original"
    const f = fixture(() => version)
    f.owner.prepare(f.input)
    await flush()
    const token = post.mock.calls[0][0].token
    blurMetadataWithDOMFocus(f.editor)
    expect(post.mock.calls.map(([command]) => command.command)).toEqual(["capturePicker"])
    act(() => {
      if (takeover === "DOM blur") f.editor.view.dom.blur()
      if (takeover === "doc edit and undo") { f.editor.commands.insertContent("edit"); f.editor.commands.undo() }
      if (takeover === "caret move and return") { f.editor.commands.setTextSelection(2); f.editor.commands.setTextSelection({ from: 6, to: 10 }) }
      if (takeover === "owner version") { version = "next"; f.editor.view.dispatch(f.editor.state.tr) }
    })
    f.input.dispatchEvent(new Event("cancel"))
    await flush()
    returnToken(token)
    expect(post.mock.calls.map(([command]) => command.command)).toEqual(["capturePicker", "cancelPicker"])
    expect(f.restore).not.toHaveBeenCalled()
    expect(f.editor.getJSON()).toEqual(f.doc)
    expect(f.editor.state.selection.toJSON()).toEqual(f.selection)
  })

  it.each(["cancel", "change"])("retains the real TipTap range/draft and original once-only input/upload on %s", async (event) => {
    const capture = deferred<{ captured: boolean }>()
    const post = vi.fn((command: Command) => command.command === "capturePicker" ? capture.promise : Promise.resolve({ restoring: true }))
    install(post)
    const f = fixture(), selected = vi.fn(), click = vi.spyOn(f.input, "click").mockImplementation(() => {})
    const handlers = createComposerAttachmentInputHandlers(() => true, {
      fileInputRef: { current: f.input }, handleFileSelect: selected,
      handleDragEnter: vi.fn(), handleDragLeave: vi.fn(), handleDragOver: vi.fn(), handleDrop: vi.fn(), removePendingFile: vi.fn(),
    }, vi.fn(), f.owner.prepare)
    f.input.addEventListener("change", (native) => handlers.onFileSelect({ currentTarget: f.input, nativeEvent: native } as Parameters<typeof handlers.onFileSelect>[0]))
    handlers.onUploadFile()
    expect(click).toHaveBeenCalledOnce()
    expect(post.mock.calls[0][0].command).toBe("capturePicker")
    returnToken(post.mock.calls[0][0].token)
    expect(f.restore).not.toHaveBeenCalled()
    f.input.dispatchEvent(new Event(event))
    await flush()
    returnToken(post.mock.calls[0][0].token)
    expect(f.restore).not.toHaveBeenCalled()
    expect(post.mock.calls.filter(([command]) => command.command === "restorePicker")).toHaveLength(0)
    capture.resolve({ captured: true })
    await flush()
    const token = post.mock.calls[0][0].token
    expect(post).toHaveBeenCalledWith({ command: "restorePicker", token })
    expect(f.restore).not.toHaveBeenCalled()
    returnToken("another-composer")
    expect(f.restore).not.toHaveBeenCalled()
    returnToken(token)
    returnToken(token)
    f.input.dispatchEvent(new Event("cancel"))
    await flush()
    expect(f.restore).toHaveBeenCalledOnce()
    expect(f.editor.view.hasFocus()).toBe(true)
    expect(f.editor.state.selection.toJSON()).toEqual(f.selection)
    expect(f.editor.getJSON()).toEqual(f.doc)
    expect(post.mock.calls.filter(([command]) => command.command === "restorePicker")).toHaveLength(1)
    expect(selected).toHaveBeenCalledTimes(event === "change" ? 1 : 0)
  })

  it.each(["unfocused", "browser", "bridge absent", "capture denied", "bridge rejects"])("keeps original behavior without restore authority: %s", async (condition) => {
    const post = vi.fn(async (_command: Command) => {
      if (condition === "bridge rejects") throw new Error("old native capability")
      return { captured: condition !== "capture denied", restoring: true }
    })
    install(post)
    const f = fixture()
    if (condition === "unfocused") f.editor.view.dom.blur()
    if (condition === "browser") Reflect.deleteProperty(window, "__TAURI__")
    if (condition === "bridge absent") Reflect.deleteProperty(window, "webkit")
    f.owner.prepare(f.input)
    f.input.dispatchEvent(new Event("cancel"))
    await flush()
    if (post.mock.calls.length) returnToken(post.mock.calls[0][0].token)
    expect(f.restore).not.toHaveBeenCalled()
  })

  it.each(["pointer", "key", "outside focus", "Send", "entry", "pagehide", "doc edit and undo", "caret move and return", "harness unmount"])("retires a delayed native return after %s", async (takeover) => {
    const post = vi.fn(async (_command: Command) => ({ captured: true, restoring: true }))
    install(post)
    const f = fixture()
    f.owner.prepare(f.input)
    f.input.dispatchEvent(new Event("cancel"))
    await flush()
    expect(post).toHaveBeenCalledWith({ command: "restorePicker", token: post.mock.calls[0][0].token })
    if (takeover === "pointer") window.dispatchEvent(new Event("pointerdown"))
    if (takeover === "key") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    if (takeover === "outside focus") {
      f.outside.focus()
      f.editor.view.focus()
    }
    if (takeover === "Send") f.owner.retire()
    if (takeover === "entry") f.leave()
    if (takeover === "pagehide") window.dispatchEvent(new Event("pagehide"))
    if (takeover === "doc edit and undo") { f.editor.commands.insertContent("edit"); f.editor.commands.undo() }
    if (takeover === "caret move and return") { f.editor.commands.setTextSelection(2); f.editor.commands.setTextSelection({ from: 6, to: 10 }) }
    if (takeover === "harness unmount") {
      f.unmount()
      expect(f.editor.isDestroyed).toBe(true)
      expect(f.input.isConnected).toBe(false)
    }
    returnToken(post.mock.calls[0][0].token)
    expect(f.restore).not.toHaveBeenCalled()
  })

  it("does not let a retired capture response or token cancel the next picker interaction", async () => {
    const old = deferred<{ captured: boolean }>()
    let captures = 0
    const post = vi.fn((command: Command) => command.command === "capturePicker" && captures++ === 0
      ? old.promise : Promise.resolve({ captured: true, restoring: true }))
    install(post)
    const f = fixture()
    f.owner.prepare(f.input)
    f.input.dispatchEvent(new Event("cancel"))
    const first = post.mock.calls[0][0].token
    f.owner.prepare(f.input)
    const next = post.mock.calls.find(([command]) => command.command === "capturePicker" && command.token !== first)![0].token
    old.resolve({ captured: false })
    await flush()
    returnToken(first)
    f.input.dispatchEvent(new Event("change"))
    await flush()
    returnToken(next)
    expect(f.restore).toHaveBeenCalledOnce()
  })
})
