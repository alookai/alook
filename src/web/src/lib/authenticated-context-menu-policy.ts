export type ContextMenuDisposition = "native" | "product"

export type ContextMenuPoint = {
  clientX: number
  clientY: number
}

type ContextMenuEventLike = ContextMenuPoint & {
  target: EventTarget | null
  composedPath(): EventTarget[]
}

type CaretPositionDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => {
    offsetNode: Node
    offset: number
  } | null
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

type PointInRange = Pick<Range, "getClientRects" | "isPointInRange">

const TEXT_INPUT_TYPES = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
])

const WORKSPACE_INVITE_PATH = /^\/invite\/[^/]+\/?$/

export function isNativeContextMenuPolicyExcludedPath(pathname: string): boolean {
  return WORKSPACE_INVITE_PATH.test(pathname)
}

export function contextMenuElementPath(
  event: Pick<ContextMenuEventLike, "target" | "composedPath">,
): Element[] {
  const path = event.composedPath()
  const elements = path.filter((target): target is Element => target instanceof Element)
  if (elements.length > 0) return elements
  return event.target instanceof Element ? [event.target] : []
}

function closestTextControl(element: Element): Element | null {
  return element.closest("input, textarea")
}

function isEditableTextControl(element: Element): boolean {
  const tagName = element.tagName.toLowerCase()
  if (tagName === "textarea") {
    const textarea = element as HTMLTextAreaElement
    return !textarea.disabled && !textarea.readOnly
  }
  if (tagName !== "input") return false

  const input = element as HTMLInputElement
  return !input.disabled && !input.readOnly && TEXT_INPUT_TYPES.has(input.type)
}

export function isEditableContextPath(path: readonly Element[]): boolean {
  for (const element of path) {
    if ((element as HTMLElement).isContentEditable) return true
    const control = closestTextControl(element)
    if (control) return isEditableTextControl(control)
  }
  return false
}

export function hasNativeContextMenuEscape(path: readonly Element[]): boolean {
  return path.some((element) => (
    element.closest('[data-native-context-menu="true"]') !== null
  ))
}

function pointInsideRect(rect: DOMRect, point: ContextMenuPoint): boolean {
  if (
    !Number.isFinite(rect.left)
    || !Number.isFinite(rect.right)
    || !Number.isFinite(rect.top)
    || !Number.isFinite(rect.bottom)
    || rect.width <= 0
    || rect.height <= 0
  ) {
    return false
  }
  return point.clientX >= rect.left
    && point.clientX <= rect.right
    && point.clientY >= rect.top
    && point.clientY <= rect.bottom
}

function caretPointFromClientPoint(
  ownerDocument: Document,
  point: ContextMenuPoint,
): { node: Node; offset: number } | null {
  const caretDocument = ownerDocument as CaretPositionDocument
  const position = caretDocument.caretPositionFromPoint?.(point.clientX, point.clientY)
  if (position) return { node: position.offsetNode, offset: position.offset }

  const range = caretDocument.caretRangeFromPoint?.(point.clientX, point.clientY)
  if (!range) return null
  return { node: range.startContainer, offset: range.startOffset }
}

export function selectionContainsClientPoint(
  selection: Selection | null,
  ownerDocument: Document,
  point: ContextMenuPoint,
): boolean {
  if (
    !selection
    || selection.isCollapsed
    || selection.rangeCount === 0
    || selection.toString().length === 0
  ) {
    return false
  }

  const caret = caretPointFromClientPoint(ownerDocument, point)
  if (!caret) return false

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index) as PointInRange
    const rectContainsPoint = Array.from(range.getClientRects())
      .some((rect) => pointInsideRect(rect, point))
    if (rectContainsPoint && range.isPointInRange(caret.node, caret.offset)) return true
  }
  return false
}

export function contextMenuDisposition({
  event,
  selection,
  ownerDocument,
}: {
  event: ContextMenuEventLike
  selection: Selection | null
  ownerDocument: Document
}): ContextMenuDisposition {
  const path = contextMenuElementPath(event)
  if (isEditableContextPath(path) || hasNativeContextMenuEscape(path)) return "native"
  return selectionContainsClientPoint(selection, ownerDocument, event)
    ? "native"
    : "product"
}
