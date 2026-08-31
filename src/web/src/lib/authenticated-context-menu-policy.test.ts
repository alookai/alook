import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  contextMenuDisposition,
  contextMenuElementPath,
  hasNativeContextMenuEscape,
  isEditableContextPath,
  isNativeContextMenuPolicyExcludedPath,
  selectionContainsClientPoint,
} from "./authenticated-context-menu-policy"

class FakeElement {
  tagName: string
  type = ""
  disabled = false
  readOnly = false
  isContentEditable = false
  parentElement: FakeElement | null = null
  private attributes = new Map<string, string>()

  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase()
    if (this.tagName === "INPUT") this.type = "text"
  }

  append(...children: FakeElement[]) {
    for (const child of children) child.parentElement = this
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  closest(selector: string): FakeElement | null {
    if (
      selector === "input, textarea"
      && (this.tagName === "INPUT" || this.tagName === "TEXTAREA")
    ) {
      return this
    }
    if (
      selector === '[data-native-context-menu="true"]'
      && this.attributes.get("data-native-context-menu") === "true"
    ) {
      return this
    }
    return this.parentElement?.closest(selector) ?? null
  }
}

function element(tagName = "div") {
  return new FakeElement(tagName) as unknown as Element
}

function eventAt(target: Element, clientX = 15, clientY = 15, path: EventTarget[] = [target]) {
  return {
    target,
    clientX,
    clientY,
    composedPath: () => path,
  }
}

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    x: 10,
    y: 10,
    left: 10,
    top: 10,
    right: 20,
    bottom: 20,
    width: 10,
    height: 10,
    toJSON: () => ({}),
    ...overrides,
  }
}

function selectionWith({
  collapsed = false,
  text = "selected",
  rects = [rect()],
  pointInRange = true,
}: {
  collapsed?: boolean
  text?: string
  rects?: DOMRect[]
  pointInRange?: boolean
} = {}): Selection {
  const range = {
    getClientRects: () => rects,
    isPointInRange: () => pointInRange,
  }
  return {
    isCollapsed: collapsed,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range,
  } as unknown as Selection
}

function ownerDocumentWith(caret: { node: Node; offset: number } | null): Document {
  return {
    caretPositionFromPoint: () => caret && ({
      offsetNode: caret.node,
      offset: caret.offset,
    }),
  } as unknown as Document
}

describe("authenticated context-menu policy", () => {
  beforeAll(() => {
    vi.stubGlobal("Element", FakeElement)
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it("excludes only the standalone workspace invite route", () => {
    expect(isNativeContextMenuPolicyExcludedPath("/invite/token")).toBe(true)
    expect(isNativeContextMenuPolicyExcludedPath("/invite/token/")).toBe(true)
    expect(isNativeContextMenuPolicyExcludedPath("/invite")).toBe(false)
    expect(isNativeContextMenuPolicyExcludedPath("/invite/token/extra")).toBe(false)
    expect(isNativeContextMenuPolicyExcludedPath("/c/invite/token")).toBe(false)
    expect(isNativeContextMenuPolicyExcludedPath("/w/demo/home")).toBe(false)
  })

  it("uses the composed element path before a retargeted event target", () => {
    const retargeted = element()
    const deepest = element("span")
    const nonElement = {} as EventTarget
    expect(contextMenuElementPath(eventAt(retargeted, 0, 0, [deepest, retargeted, nonElement])))
      .toEqual([deepest, retargeted])
    expect(contextMenuElementPath({
      target: retargeted,
      composedPath: () => [nonElement],
    })).toEqual([retargeted])
  })

  it.each(["text", "search", "email", "url", "tel", "password", "number"])(
    "keeps an enabled %s input native",
    (type) => {
      const input = element("input") as unknown as FakeElement
      input.type = type
      expect(isEditableContextPath([input as unknown as Element])).toBe(true)
      input.readOnly = true
      expect(isEditableContextPath([input as unknown as Element])).toBe(false)
      input.readOnly = false
      input.disabled = true
      expect(isEditableContextPath([input as unknown as Element])).toBe(false)
    },
  )

  it("recognizes default text input, textarea descendants, and effective contenteditable", () => {
    const input = element("input") as unknown as FakeElement
    const textarea = element("textarea") as unknown as FakeElement
    const inputChild = element("span") as unknown as FakeElement
    const editableChild = element("span") as unknown as FakeElement
    input.append(inputChild)
    editableChild.isContentEditable = true

    expect(isEditableContextPath([input as unknown as Element])).toBe(true)
    expect(isEditableContextPath([textarea as unknown as Element])).toBe(true)
    expect(isEditableContextPath([inputChild as unknown as Element])).toBe(true)
    expect(isEditableContextPath([editableChild as unknown as Element])).toBe(true)
    textarea.readOnly = true
    expect(isEditableContextPath([textarea as unknown as Element])).toBe(false)
  })

  it.each(["checkbox", "radio", "range", "file", "button", "color", "date"])(
    "keeps a %s input product-owned",
    (type) => {
      const input = element("input") as unknown as FakeElement
      input.type = type
      expect(isEditableContextPath([input as unknown as Element])).toBe(false)
    },
  )

  it("does not infer editability from select or ARIA", () => {
    expect(isEditableContextPath([element("select")])).toBe(false)
    expect(isEditableContextPath([element("div")])).toBe(false)
  })

  it("requires the exact native escape value on the target path or an ancestor", () => {
    const wrapper = element() as unknown as FakeElement
    const child = element("span") as unknown as FakeElement
    const sibling = element("span") as unknown as FakeElement
    wrapper.append(child, sibling)
    wrapper.setAttribute("data-native-context-menu", "true")
    expect(hasNativeContextMenuEscape([child as unknown as Element])).toBe(true)
    wrapper.setAttribute("data-native-context-menu", "false")
    expect(hasNativeContextMenuEscape([child as unknown as Element])).toBe(false)
    wrapper.setAttribute("data-native-context-menu", "")
    expect(hasNativeContextMenuEscape([child as unknown as Element])).toBe(false)
    sibling.setAttribute("data-native-context-menu", "true")
    expect(hasNativeContextMenuEscape([child as unknown as Element])).toBe(false)
  })

  it("requires both selected geometry and caret containment", () => {
    const text = {} as Node
    const ownerDocument = ownerDocumentWith({ node: text, offset: 3 })
    expect(selectionContainsClientPoint(selectionWith(), ownerDocument, { clientX: 15, clientY: 15 })).toBe(true)
    expect(selectionContainsClientPoint(selectionWith(), ownerDocument, { clientX: 25, clientY: 15 })).toBe(false)
    expect(selectionContainsClientPoint(selectionWith({ pointInRange: false }), ownerDocument, {
      clientX: 15,
      clientY: 15,
    })).toBe(false)
    expect(selectionContainsClientPoint(selectionWith({ collapsed: true }), ownerDocument, {
      clientX: 15,
      clientY: 15,
    })).toBe(false)
    expect(selectionContainsClientPoint(selectionWith({ text: "" }), ownerDocument, {
      clientX: 15,
      clientY: 15,
    })).toBe(false)
    expect(selectionContainsClientPoint(selectionWith({ rects: [rect({ width: 0, right: 10 })] }), ownerDocument, {
      clientX: 10,
      clientY: 15,
    })).toBe(false)
  })

  it("falls back to caretRangeFromPoint and accepts selection boundaries", () => {
    const text = {} as Node
    const ownerDocument = {
      caretPositionFromPoint: undefined,
      caretRangeFromPoint: () => ({ startContainer: text, startOffset: 0 }),
    } as unknown as Document
    expect(selectionContainsClientPoint(selectionWith(), ownerDocument, { clientX: 10, clientY: 10 })).toBe(true)
    expect(selectionContainsClientPoint(selectionWith(), ownerDocument, { clientX: 20, clientY: 20 })).toBe(true)
  })

  it("checks every selection range", () => {
    const ownerDocument = ownerDocumentWith({ node: {} as Node, offset: 1 })
    const ranges = [
      { getClientRects: () => [rect({ left: 30, right: 40, x: 30 })], isPointInRange: () => false },
      { getClientRects: () => [rect()], isPointInRange: () => true },
    ]
    const selection = {
      isCollapsed: false,
      rangeCount: 2,
      toString: () => "selected",
      getRangeAt: (index: number) => ranges[index],
    } as unknown as Selection
    expect(selectionContainsClientPoint(selection, ownerDocument, { clientX: 15, clientY: 15 })).toBe(true)
  })

  it("reduces editable, escape, and selected-point facts to native disposition", () => {
    const ownerDocument = ownerDocumentWith({ node: {} as Node, offset: 1 })
    const input = element("input")
    expect(contextMenuDisposition({
      event: eventAt(input),
      selection: null,
      ownerDocument,
    })).toBe("native")

    const escape = element() as unknown as FakeElement
    escape.setAttribute("data-native-context-menu", "true")
    expect(contextMenuDisposition({
      event: eventAt(escape as unknown as Element),
      selection: null,
      ownerDocument,
    })).toBe("native")

    const plain = element()
    expect(contextMenuDisposition({
      event: eventAt(plain),
      selection: selectionWith(),
      ownerDocument,
    })).toBe("native")
    expect(contextMenuDisposition({
      event: eventAt(plain, 30, 30),
      selection: selectionWith(),
      ownerDocument,
    })).toBe("product")
  })
})
