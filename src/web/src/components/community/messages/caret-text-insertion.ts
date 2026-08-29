const IDENTIFIER_CHAR = /[\p{L}\p{N}_-]/u

type CaretInsertionState = {
  selection: { from: number; to: number }
  doc: {
    content: { size: number }
    textBetween: (from: number, to: number, blockSeparator?: string, leafText?: string) => string
  }
}

function caretBoundarySpacing(state: CaretInsertionState): {
  leading: boolean
  trailing: boolean
} {
  const { from, to } = state.selection
  const beforeText = state.doc.textBetween(Math.max(0, from - 2), from, "\n", "\n")
  const afterText = state.doc.textBetween(to, Math.min(state.doc.content.size, to + 2), "\n", "\n")
  const before = Array.from(beforeText).at(-1)
  const after = Array.from(afterText)[0]
  return {
    leading: !!before && IDENTIFIER_CHAR.test(before),
    trailing: after === undefined || IDENTIFIER_CHAR.test(after),
  }
}

function textWithCaretBoundaries(
  text: string,
  spacing: { leading: boolean; trailing: boolean },
): string {
  if (!text) return text
  const leadingSpace = spacing.leading && !/^\s/u.test(text) ? " " : ""
  const trailingSpace = spacing.trailing && !/\s$/u.test(text) ? " " : ""
  return `${leadingSpace}${text}${trailingSpace}`
}

export function textNodeForCaretInsertion(
  text: string,
  state: CaretInsertionState,
): { type: "text"; text: string } {
  const spacing = caretBoundarySpacing(state)
  return {
    type: "text",
    text: textWithCaretBoundaries(text, spacing),
  }
}

export function mentionNodesForCaretInsertion(
  mention: { id: string; label: string },
  state: CaretInsertionState,
): Array<
  | { type: "text"; text: string }
  | { type: "mention"; attrs: { id: string; label: string } }
> {
  const spacing = caretBoundarySpacing(state)
  return [
    ...(spacing.leading ? [{ type: "text" as const, text: " " }] : []),
    { type: "mention" as const, attrs: mention },
    ...(spacing.trailing ? [{ type: "text" as const, text: " " }] : []),
  ]
}
