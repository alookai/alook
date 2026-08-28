const IDENTIFIER_CHAR = /[\p{L}\p{N}_-]/u

function textWithCaretBoundaries(
  text: string,
  before: string | undefined,
  after: string | undefined,
): string {
  if (!text) return text
  const leadingSpace = before && IDENTIFIER_CHAR.test(before) && !/^\s/u.test(text)
    ? " "
    : ""
  const trailingSpace = (after === undefined || IDENTIFIER_CHAR.test(after)) && !/\s$/u.test(text)
    ? " "
    : ""
  return `${leadingSpace}${text}${trailingSpace}`
}

export function textNodeForCaretInsertion(text: string, state: {
  selection: { from: number; to: number }
  doc: {
    content: { size: number }
    textBetween: (from: number, to: number, blockSeparator?: string, leafText?: string) => string
  }
}): { type: "text"; text: string } {
  const { from, to } = state.selection
  const beforeText = state.doc.textBetween(Math.max(0, from - 2), from, "\n", "\n")
  const afterText = state.doc.textBetween(to, Math.min(state.doc.content.size, to + 2), "\n", "\n")
  return {
    type: "text",
    text: textWithCaretBoundaries(
      text,
      Array.from(beforeText).at(-1),
      Array.from(afterText)[0],
    ),
  }
}
