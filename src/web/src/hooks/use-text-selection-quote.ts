import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useEffect } from "react";

export type SelectionPopup = {
  text: string;
  messageId: string | null;
  x: number;
  y: number;
} | null;

/**
 * Owns the "quote selected text" popup: tracks the current text selection
 * (only inside `[data-quote-source]` regions) and positions the popup, via a
 * document `selectionchange` listener.
 *
 * Extracted verbatim from agent-chat-view.tsx. Call this hook at the SAME
 * position the `selectionchange` effect previously occupied so its registration
 * order is preserved. The `selectionPopup` state + raw `setSelectionPopup`
 * setter are returned so the component's quote handler (which also writes the
 * composer draft + focuses the editor) stays byte-identical.
 */
export function useTextSelectionQuote() {
  const [selectionPopup, setSelectionPopup] = useAtom(useCreateAtom<SelectionPopup>(null));

  const handleTextSelect = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      setSelectionPopup(null);
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setSelectionPopup(null);
      return;
    }
    // Only allow quoting from assistant message bubbles
    const range = selection.getRangeAt(0);
    const container =
      range.commonAncestorContainer instanceof HTMLElement
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const quoteSource = container?.closest("[data-quote-source]");
    if (!quoteSource) {
      setSelectionPopup(null);
      return;
    }
    const msgEl = quoteSource.closest("[data-message-id]");
    const messageId = msgEl?.getAttribute("data-message-id") ?? null;
    const rects = range.getClientRects();
    const lastRect = rects[rects.length - 1] || range.getBoundingClientRect();
    setSelectionPopup({ text, messageId, x: lastRect.right, y: lastRect.top - 4 });
  }, [setSelectionPopup]);

  useEffect(() => {
    document.addEventListener("selectionchange", handleTextSelect);
    return () =>
      document.removeEventListener("selectionchange", handleTextSelect);
  }, [handleTextSelect]);

  return { selectionPopup, setSelectionPopup };
}
