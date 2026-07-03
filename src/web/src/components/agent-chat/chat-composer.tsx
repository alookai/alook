"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useKeyboardScroll } from "@/hooks/use-keyboard-scroll";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { rankMentionAgents } from "@/lib/mention-agents";
import { buildChatMentionExtension } from "@/lib/chat-mention-extension";
import { decodeChatEntities } from "@/lib/chat-markdown";
import { toAlookAddress } from "@alook/shared";
import type { Agent, AgentLink } from "@alook/shared";
import type { PopupKeyEvent } from "@/hooks/use-slash-command";

/**
 * Imperative handle the parent (agent-chat-view) drives. The parent keeps
 * owning send / banners / persistence / slash-command state; the composer only
 * owns the TipTap editor and surfaces just enough to anchor the slash popup.
 */
export interface ChatComposerHandle {
  focus: () => void;
  clear: () => void;
  isEmpty: () => boolean;
  /** Viewport coords for a plain-text caret index — used to anchor the slash popup. */
  coordsAtTextIndex: (index: number) => { top: number; left: number } | null;
}

interface ChatComposerProps {
  /** Markdown string — the controlled source of truth (parent's `input`). */
  value: string;
  onChange: (markdown: string) => void;
  /** Reports the editor's plain text + caret index so the parent can drive slash. */
  onEditorState: (plainText: string, caretIndex: number) => void;
  /** Enter-to-send (only fires in a top-level paragraph, no popup open). */
  onSend: () => void;
  /** Editor gained focus (forwarded live via useEditor's onFocus — no re-mount). */
  onFocus?: () => void;
  /** Editor lost focus (forwarded live via useEditor's onBlur — no re-mount). */
  onBlur?: () => void;
  /**
   * The placeholder, rendered as a decorative overlay over the empty editor.
   * This is the SOLE placeholder renderer — TipTap's own Placeholder is kept
   * permanently "" because its decoration is captured at plugin-init and does
   * NOT re-read updated options in this @tiptap/extensions version (so it goes
   * stale on the in-place active↔idle settle). The parent drives the text + fade
   * for BOTH the idle rotating hint and the active static "Message {Name}".
   */
  overlay?: ReactNode;
  disabled?: boolean;
  /** Drives the rounded-3xl ↔ rounded-2xl pill switch. */
  onMultiLineChange?: (multiline: boolean) => void;
  /** Files extracted from paste/drop — parent validates + stages them. */
  onFiles?: (files: File[]) => void;

  // Mentions
  agents: Agent[];
  agentLinks: AgentLink[];
  currentAgentId: string;

  // Slash command (state owned by the parent's useSlashCommand)
  slashIsOpen: boolean;
  onSlashKeyDown: (e: PopupKeyEvent) => boolean;
}

// ── Mention suggestion popup (self-contained, mirrors markdown-editor.tsx) ──

type MentionSuggestionProps = {
  items: Agent[];
  command: (props: { id: string; label: string }) => void;
  clientRect?: (() => DOMRect | null) | null;
};

interface MentionPopupState {
  items: Agent[];
  selectedIndex: number;
  command: ((props: { id: string; label: string }) => void) | null;
  rect: DOMRect | null;
}

const EMPTY_MENTION_STATE: MentionPopupState = {
  items: [],
  selectedIndex: 0,
  command: null,
  rect: null,
};

function MentionList({ state }: { state: MentionPopupState }) {
  const listRef = useRef<HTMLDivElement>(null);
  const { items, selectedIndex, command, rect } = state;

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!rect || items.length === 0 || !command) return null;

  // Popup is w-64 (256px). Clamp left so it never overflows the right edge (mobile).
  const POPUP_WIDTH = 256;
  const VIEWPORT_MARGIN = 8;
  const maxLeft = typeof window !== "undefined"
    ? Math.max(VIEWPORT_MARGIN, window.innerWidth - POPUP_WIDTH - VIEWPORT_MARGIN)
    : rect.left;
  const clampedLeft = Math.min(rect.left, maxLeft);

  return createPortal(
    <div
      className="fixed z-100 w-64 rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
      style={{ top: rect.top - 4, left: clampedLeft, transform: "translateY(-100%)" }}
    >
      <div ref={listRef} className="max-h-50 overflow-y-auto py-1 thin-scrollbar">
        {items.map((agent, i) => (
          <button
            key={agent.id}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
              i === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
            )}
            onMouseDown={(e) => {
              e.preventDefault();
              command({ id: agent.id, label: agent.name });
            }}
          >
            <span className="truncate font-medium">{agent.name}</span>
            {agent.email_handle && (
              <span className="truncate text-xs text-muted-foreground">
                {toAlookAddress(agent.email_handle)}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/** fade duration each way; total swap = 2× this. Matches the spec (200/200). */
const PLACEHOLDER_FADE_MS = 200;

/**
 * Decorative overlay for the rotating capability-hint placeholder. Rendered as
 * a sibling of <EditorContent> inside `.chat-composer` (which is `relative`),
 * absolutely positioned at the editor's text origin so it overlaps the empty
 * first paragraph exactly and adds zero layout height.
 *
 * Cross-fade: on `hint` change, fade the current text OUT (200ms), swap the
 * text at zero opacity, then fade the new text IN — so the text never snaps
 * mid-opacity (the flicker the overlay exists to avoid). With `animate=false`
 * (reduced motion) the hint swaps instantly, no transition.
 *
 * aria-hidden: this is purely visual — the editor keeps its real accessible
 * name and screen readers must NOT announce hint rotation.
 */
export function RotatingPlaceholderOverlay({
  hint,
  animate,
}: {
  hint: string;
  /** false → reduced-motion: render the single hint with no fade. */
  animate: boolean;
}) {
  // `shown` is the text currently painted; `visible` drives opacity. On a hint
  // change we fade out, then swap `shown` + fade back in.
  const [shown, setShown] = useState(hint);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!animate) {
      // Reduced motion: no fade, just show the latest hint.
      setShown(hint);
      setVisible(true);
      return;
    }
    if (hint === shown) return;
    setVisible(false); // fade out
    const id = setTimeout(() => {
      setShown(hint); // swap at opacity 0
      setVisible(true); // fade in
    }, PLACEHOLDER_FADE_MS);
    return () => clearTimeout(id);
  }, [hint, shown, animate]);

  return (
    <div className="chat-placeholder-overlay" aria-hidden="true">
      <span
        className={animate ? "chat-placeholder-fade" : undefined}
        style={animate ? { opacity: visible ? 1 : 0 } : undefined}
      >
        {shown}
      </span>
    </div>
  );
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(
  function ChatComposer(
    {
      value,
      onChange,
      onEditorState,
      onSend,
      onFocus,
      onBlur,
      overlay,
      disabled,
      onMultiLineChange,
      onFiles,
      agents,
      agentLinks,
      currentAgentId,
      slashIsOpen,
      onSlashKeyDown,
    },
    ref,
  ) {
    const [editorFocused, setEditorFocused] = useState(false);
    const [mentionPopup, setMentionPopup] = useState<MentionPopupState>(EMPTY_MENTION_STATE);
    const mentionPopupRef = useRef(mentionPopup);
    useEffect(() => {
      mentionPopupRef.current = mentionPopup;
    }, [mentionPopup]);

    // The editor is built once, so anything its callbacks read must be a ref.
    const agentsRef = useRef(agents);
    const agentLinksRef = useRef(agentLinks);
    const currentAgentIdRef = useRef(currentAgentId);
    const onSendRef = useRef(onSend);
    const onEditorStateRef = useRef(onEditorState);
    const onChangeRef = useRef(onChange);
    const onFilesRef = useRef(onFiles);
    const onFocusRef = useRef(onFocus);
    const onBlurRef = useRef(onBlur);
    const slashIsOpenRef = useRef(slashIsOpen);
    const onSlashKeyDownRef = useRef(onSlashKeyDown);
    useEffect(() => { agentsRef.current = agents; }, [agents]);
    useEffect(() => { agentLinksRef.current = agentLinks; }, [agentLinks]);
    useEffect(() => { currentAgentIdRef.current = currentAgentId; }, [currentAgentId]);
    useEffect(() => { onSendRef.current = onSend; }, [onSend]);
    useEffect(() => { onEditorStateRef.current = onEditorState; }, [onEditorState]);
    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
    useEffect(() => { onFilesRef.current = onFiles; }, [onFiles]);
    useEffect(() => { onFocusRef.current = onFocus; }, [onFocus]);
    useEffect(() => { onBlurRef.current = onBlur; }, [onBlur]);
    useEffect(() => { slashIsOpenRef.current = slashIsOpen; }, [slashIsOpen]);
    useEffect(() => { onSlashKeyDownRef.current = onSlashKeyDown; }, [onSlashKeyDown]);

    // Report plain text + caret to the parent (it drives the slash-command
    // popup). NOTE: `selection.from - 1` only equals the true plain-text index
    // in a single-paragraph doc — it diverges across block boundaries. The only
    // consumer (slash commands, which trigger ONLY at the start of input) is in
    // a top-level paragraph, so the mapping holds there. Don't trust this index
    // for multi-block positions without revisiting.
    const reportState = (editor: NonNullable<ReturnType<typeof useEditor>>) => {
      onEditorStateRef.current(editor.getText(), editor.state.selection.from - 1);
    };

    // The mention extension is built once (refs read inside its callbacks fire
    // at suggestion-time, not render-time). Keeping it in a lazy state init
    // also stops it being rebuilt on every render. The .current reads below are
    // all inside suggestion callbacks invoked at runtime, never during render.
    // eslint-disable-next-line react-hooks/refs -- refs read in runtime callbacks, not render
    const [mentionExtension] = useState(() =>
      buildChatMentionExtension().configure({
        HTMLAttributes: { class: "mention-highlight" },
        renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
        suggestion: {
          char: "@",
          items: ({ query }: { query: string }) =>
            rankMentionAgents(
              agentsRef.current,
              agentLinksRef.current,
              currentAgentIdRef.current,
              query,
            ),
          render: () => ({
            onStart: (props: MentionSuggestionProps) => {
              setMentionPopup({
                items: props.items ?? [],
                selectedIndex: 0,
                command: props.command,
                rect: props.clientRect?.() ?? null,
              });
            },
            onUpdate: (props: MentionSuggestionProps) => {
              setMentionPopup((cur) => ({
                items: props.items ?? [],
                selectedIndex:
                  cur.selectedIndex < (props.items?.length ?? 0) ? cur.selectedIndex : 0,
                command: props.command,
                rect: props.clientRect?.() ?? null,
              }));
            },
            onKeyDown: ({ event }: { event: KeyboardEvent }) => {
              // IME guard: while composing (CJK), Enter confirms the
              // composition — it must not select a mention. Mirrors the Enter
              // guards in the slash hook and the send path.
              if (event.isComposing) return false;
              const cur = mentionPopupRef.current;
              if (cur.items.length === 0) return false;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMentionPopup((s) => ({
                  ...s,
                  selectedIndex: (s.selectedIndex + 1) % s.items.length,
                }));
                return true;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setMentionPopup((s) => ({
                  ...s,
                  selectedIndex: (s.selectedIndex - 1 + s.items.length) % s.items.length,
                }));
                return true;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const agent = cur.items[cur.selectedIndex];
                if (agent && cur.command) cur.command({ id: agent.id, label: agent.name });
                setMentionPopup(EMPTY_MENTION_STATE);
                return true;
              }
              if (event.key === "Escape") {
                setMentionPopup(EMPTY_MENTION_STATE);
                return true;
              }
              return false;
            },
            onExit: () => setMentionPopup(EMPTY_MENTION_STATE),
          }),
        },
      }),
    );

    const editor = useEditor({
      immediatelyRender: false,
      content: value ? value.replaceAll("\n", "<br>") : undefined,
      editable: !disabled,
      extensions: [
        StarterKit.configure({
          heading: false,
          blockquote: false,
          codeBlock: false,
          horizontalRule: false,
          bold: false,
          italic: false,
          strike: false,
          code: false,
          link: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          listKeymap: false,
        }),
        // TipTap's own placeholder is permanently empty: its decoration value is
        // captured at plugin-init and does NOT re-read updated options in this
        // @tiptap/extensions version, so a reactive value goes stale on the
        // in-place active↔idle settle (the double-image). The `overlay` prop is
        // the single source of truth for the placeholder instead — see below.
        Placeholder.configure({ placeholder: "" }),
        Markdown,
        mentionExtension,
      ],
      editorProps: {
        attributes: {
          class: "outline-none",
          enterkeyhint: "send",
        },
        handleKeyDown: (_view, event) => {
          // Precedence: mention suggestion > slash popup > Enter-to-send.
          //
          // editorProps.handleKeyDown runs BEFORE plugin keymaps in
          // ProseMirror, so the @tiptap/suggestion mention plugin does NOT get
          // first crack at Enter — we must explicitly bail here while the
          // mention popup is open, or Enter would send instead of selecting the
          // highlighted agent. (Arrow/Esc fall through fine; only Enter clashes.)
          const mentionOpen =
            mentionPopupRef.current.items.length > 0 && mentionPopupRef.current.command !== null;
          if (mentionOpen) return false;

          if (
            slashIsOpenRef.current &&
            onSlashKeyDownRef.current({
              key: event.key,
              isComposing: event.isComposing,
              preventDefault: () => event.preventDefault(),
            })
          ) {
            return true;
          }

          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            if (!slashIsOpenRef.current) {
              event.preventDefault();
              onSendRef.current();
              return true;
            }
          }
          return false;
        },
        handlePaste: (view, event) => {
          const items = event.clipboardData?.items;
          if (!items) return false;
          const files: File[] = [];
          for (let i = 0; i < items.length; i++) {
            if (items[i].kind === "file") {
              const f = items[i].getAsFile();
              if (f) files.push(f);
            }
          }
          if (files.length > 0) {
            event.preventDefault();
            onFilesRef.current?.(files);
            return true;
          }
          const text = event.clipboardData?.getData("text/plain");
          if (text) {
            event.preventDefault();
            view.dispatch(view.state.tr.insertText(text));
            return true;
          }
          return false;
        },
        handleDrop: () => false,
      },
      onFocus: () => { setEditorFocused(true); onFocusRef.current?.(); },
      onBlur: () => { setEditorFocused(false); onBlurRef.current?.(); },
      onUpdate: ({ editor }) => {
        onChangeRef.current(decodeChatEntities(editor.getMarkdown()));
        reportState(editor);
      },
      onSelectionUpdate: ({ editor }) => {
        reportState(editor);
      },
    });

    // Keep editable in sync with disabled.
    useEffect(() => {
      editor?.setEditable(!disabled);
    }, [editor, disabled]);

    // Controlled value: push external changes (draft restore /
    // conversation switch / clear-after-send) into the editor.
    // emitUpdate:false avoids a feedback loop.
    useEffect(() => {
      if (!editor) return;
      const incoming = (value || "").trim();
      // Decode so this matches the (decoded) markdown the parent stored via
      // onChange — otherwise text with < > & always mismatches and we'd reset
      // content (and the caret) on every keystroke.
      const current = decodeChatEntities(editor.getMarkdown() || "").trim();
      if (incoming === current) return;
      if (!incoming) {
        editor.commands.clearContent();
      } else {
        editor.commands.setContent((value || "").replaceAll("\n", "<br>"), { emitUpdate: false });
      }
      onEditorStateRef.current(editor.getText(), editor.state.selection.from - 1);
    }, [value, editor]);

    // Multi-line detection drives the pill rounding.
    const contentRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (!editor || !onMultiLineChange) return;
      const el = contentRef.current?.querySelector(".ProseMirror") as HTMLElement | null;
      if (!el) return;
      const check = () => onMultiLineChange(el.scrollHeight > 32);
      check();
      const observer = new ResizeObserver(check);
      observer.observe(el);
      return () => observer.disconnect();
    }, [editor, onMultiLineChange]);

    // iOS Safari fallback: scroll composer into view when the virtual keyboard resizes
    // the visual viewport.
    useKeyboardScroll(contentRef, editorFocused);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => editor?.commands.focus(),
        clear: () => editor?.commands.clearContent(),
        isEmpty: () => editor?.isEmpty ?? true,
        coordsAtTextIndex: (index: number) => {
          if (!editor) return null;
          try {
            // +1: plain-text index is 0-based; PM positions start at 1.
            const coords = editor.view.coordsAtPos(index + 1);
            return { top: coords.top, left: coords.left };
          } catch {
            return null;
          }
        },
      }),
      [editor],
    );

    return (
      <div ref={contentRef} className="chat-composer relative">
        <EditorContent
          editor={editor}
          className="max-h-44 overflow-y-auto thin-scrollbar pr-2 text-base chat-input-line-height"
        />
        {/* Decorative rotating-placeholder overlay. Renders over the empty
            editor's text origin (mirrors the ::before float:left;height:0
            position) so it adds zero layout height. aria-hidden — never
            announced; the editor keeps its own accessible name. The parent
            only mounts this while the field is empty + unfocused + idle. */}
        {overlay}
        <MentionList state={mentionPopup} />
      </div>
    );
  },
);
