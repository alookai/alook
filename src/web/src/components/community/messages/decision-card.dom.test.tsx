import { act, fireEvent, render } from "@/test/react-dom-harness"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { DecisionCardInputSchema, buildDecisionCardEmbed, type DecisionCardEmbed } from "@alook/shared"
import { tid } from "@/lib/community/testids"
import { DecisionCard } from "./decision-card"
import { Message } from "./message"

beforeAll(() => {
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  }
})

function sampleCard(overrides?: Partial<DecisionCardEmbed>): DecisionCardEmbed {
  const input = DecisionCardInputSchema.parse({
    summary: "Pick rollout details",
    questions: [
      {
        id: "timing",
        header: "Timing",
        question: "When should we ship?",
        options: [
          { id: "today", label: "Today", description: "Ship now", recommended: true },
          { id: "next", label: "Next week" },
        ],
      },
      {
        id: "targets",
        header: "Targets",
        question: "Which surfaces first?",
        multiSelect: true,
        options: [
          { id: "web", label: "Web" },
          { id: "desktop", label: "Desktop" },
        ],
      },
    ],
  })
  return {
    ...buildDecisionCardEmbed(input, [{ userId: "u_gus", handle: "gus#1813" }]),
    ...overrides,
  }
}

describe("DecisionCard", () => {
  it("uses tabs for multi-question cards, auto-advances on single-select, gates submit until all answered, preserves drafts, and keeps stable retry nonce", async () => {
    const onSubmit = vi
      .fn<
        (messageId: string, content: string, nonce: string) => Promise<{ replyToId: string | null }>
      >()
      .mockRejectedValueOnce(new Error("Network offline"))
      .mockResolvedValueOnce({ replyToId: null })
      .mockResolvedValueOnce({ replyToId: "m_q1" })

    const view = render(
      <DecisionCard
        card={sampleCard()}
        messageId="m_q1"
        authorId="bot_evan"
        viewerUserId="u_gus"
        onSubmit={onSubmit}
      />,
    )

    // Multi-question shows Tabs and hides submit until all questions are answered.
    expect(view.getByTestId(tid.decisionCardTab("timing"))).toHaveTextContent("Timing")
    expect(view.getByTestId(tid.decisionCardTab("targets"))).toHaveTextContent("Targets")
    expect(view.queryByTestId(tid.decisionCardSubmit)).toBeNull()
    expect(view.queryByTestId(tid.decisionCardOption("targets", "web"))).toBeNull()

    // Selecting single-select option auto-advances to the next unanswered tab (Targets).
    fireEvent.click(view.getByTestId(tid.decisionCardOption("timing", "today")))
    expect(view.getByTestId(tid.decisionCardOption("targets", "web"))).toBeVisible()
    expect(view.queryByTestId(tid.decisionCardSubmit)).toBeNull()

    // Multi-select checkboxes do NOT auto-advance; selecting Web satisfies Targets so submit appears.
    fireEvent.click(view.getByTestId(tid.decisionCardOption("targets", "web")))
    expect(view.getByTestId(tid.decisionCardSubmit)).toBeVisible()

    // Toggling Other with empty text hides submit until text is entered.
    fireEvent.click(view.getByTestId(tid.decisionCardOtherToggle("targets")))
    expect(view.queryByTestId(tid.decisionCardSubmit)).toBeNull()
    fireEvent.change(view.getByTestId(tid.decisionCardOtherInput("targets")), {
      target: { value: "Mobile" },
    })
    expect(view.getByTestId(tid.decisionCardSubmit)).toBeVisible()

    // Switching back to Timing and returning to Targets preserves both drafts.
    fireEvent.click(view.getByTestId(tid.decisionCardTab("timing")))
    expect(view.getByTestId(tid.decisionCardOption("timing", "today"))).toHaveAttribute("data-selected", "true")
    fireEvent.click(view.getByTestId(tid.decisionCardTab("targets")))
    expect(view.getByTestId(tid.decisionCardOtherInput("targets"))).toHaveValue("Mobile")

    // First submit fails (network) -> keeps error and preserves nonce for retry.
    await act(async () => {
      fireEvent.click(view.getByTestId(tid.decisionCardSubmit))
    })
    expect(view.getByRole("alert")).toHaveTextContent("Network offline")
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const firstNonce = onSubmit.mock.calls[0]![2]
    expect(onSubmit.mock.calls[0]![1]).toContain("1. Timing: Today")
    expect(onSubmit.mock.calls[0]![1]).toContain("2. Targets: Web, Other: Mobile")

    // Second submit returns dropped replyToId -> reuses nonce, does NOT show "Answer sent".
    await act(async () => {
      fireEvent.click(view.getByTestId(tid.decisionCardSubmit))
    })
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(onSubmit.mock.calls[1]![2]).toBe(firstNonce)
    expect(view.queryByRole("status")).toBeNull()
    expect(view.getByRole("alert")).toHaveTextContent("Could not link your answer")

    // Third submit succeeds with matching replyToId -> shows "Answer sent".
    await act(async () => {
      fireEvent.click(view.getByTestId(tid.decisionCardSubmit))
    })
    expect(onSubmit).toHaveBeenCalledTimes(3)
    expect(view.getByRole("status")).toHaveTextContent("Answer sent")

    view.unmount()
  })

  it("shows Next for multi-select and Other when another unanswered tab remains, and falls back to Q1/Q2 tab labels", () => {
    const input = DecisionCardInputSchema.parse({
      summary: "Pick platforms and timing",
      questions: [
        {
          id: "first",
          question: "Pick platforms",
          multiSelect: true,
          options: [
            { id: "web", label: "Web" },
            { id: "ios", label: "iOS" },
          ],
        },
        {
          id: "second",
          question: "When?",
          options: [
            { id: "now", label: "Now" },
            { id: "later", label: "Later" },
          ],
        },
      ],
    })
    const card = buildDecisionCardEmbed(input, [{ userId: "u_gus", handle: "gus#1813" }])
    const view = render(
      <DecisionCard
        card={card}
        messageId="m_q2"
        authorId="bot_evan"
        viewerUserId="u_gus"
        onSubmit={vi.fn(async () => ({ replyToId: "m_q2" }))}
      />,
    )

    expect(view.getByTestId(tid.decisionCardTab("first"))).toHaveTextContent("Q1")
    expect(view.getByTestId(tid.decisionCardTab("second"))).toHaveTextContent("Q2")
    expect(view.queryByTestId(tid.decisionCardNext)).toBeNull()

    fireEvent.click(view.getByTestId(tid.decisionCardOption("first", "web")))
    expect(view.getByTestId(tid.decisionCardNext)).toBeVisible()
    expect(view.queryByTestId(tid.decisionCardSubmit)).toBeNull()

    // IME composing Enter inside Other must NOT jump tabs; committed Enter advances.
    fireEvent.click(view.getByTestId(tid.decisionCardOtherToggle("first")))
    const otherInput = view.getByTestId(tid.decisionCardOtherInput("first"))
    fireEvent.change(otherInput, { target: { value: "桌面" } })
    fireEvent.keyDown(otherInput, { key: "Enter", isComposing: true })
    expect(view.queryByTestId(tid.decisionCardOption("second", "now"))).toBeNull()
    fireEvent.keyDown(otherInput, { key: "Enter", isComposing: false })
    expect(view.getByTestId(tid.decisionCardOption("second", "now"))).toBeVisible()

    fireEvent.click(view.getByTestId(tid.decisionCardOption("second", "now")))
    expect(view.getByTestId(tid.decisionCardSubmit)).toBeVisible()
    view.unmount()
  })

  it("renders single-question cards without tabs and gates Send answer until selected", () => {
    const input = DecisionCardInputSchema.parse({
      summary: "Confirm release today",
      questions: [
        {
          id: "only",
          header: "Release",
          question: "Ship today?",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        },
      ],
    })
    const card = buildDecisionCardEmbed(input, [{ userId: "u_gus", handle: "gus#1813" }])
    const view = render(
      <DecisionCard
        card={card}
        messageId="m_single"
        authorId="bot_evan"
        viewerUserId="u_gus"
        onSubmit={vi.fn(async () => ({ replyToId: "m_single" }))}
      />,
    )

    expect(view.queryByTestId(tid.decisionCardTab("only"))).toBeNull()
    expect(view.queryByTestId(tid.decisionCardSubmit)).toBeNull()

    fireEvent.click(view.getByTestId(tid.decisionCardOption("only", "yes")))
    expect(view.getByTestId(tid.decisionCardSubmit)).toHaveTextContent("Send answer")
    view.unmount()
  })

  it("merges hydrated and live responders, deduplicating per user and ignoring question author", () => {
    const view = render(
      <DecisionCard
        card={sampleCard({
          assignees: [
            { userId: "u_gus", handle: "gus#1813" },
            { userId: "u_alice", handle: "alice#0001" },
          ],
          respondedUserIds: ["u_gus", "bot_evan"],
        })}
        messageId="m_q1"
        authorId="bot_evan"
        viewerUserId="u_gus"
        liveRespondedUserIds={["u_gus", "u_alice", "bot_evan"]}
        onSubmit={vi.fn(async () => ({ replyToId: "m_q1" }))}
      />,
    )

    expect(view.getByTestId(tid.decisionCardResponders)).toHaveTextContent("2/2 responded")
    view.unmount()
  })

  it("renders read-only notice without submit button for unassigned viewers", () => {
    const view = render(
      <DecisionCard
        card={sampleCard()}
        messageId="m_q1"
        authorId="bot_evan"
        viewerUserId="u_other"
        onSubmit={vi.fn(async () => ({ replyToId: "m_q1" }))}
      />,
    )
    expect(view.queryByTestId(tid.decisionCardSubmit)).toBeNull()
    expect(view.getByTestId(tid.decisionCardReadonlyNotice)).toHaveTextContent("Waiting for @gus to answer")
    const optionControl = view.getByTestId(tid.decisionCardOption("timing", "today")).querySelector('[role="radio"]')
    expect(optionControl).toHaveAttribute("aria-disabled", "true")
    view.unmount()
  })

  it("renders DecisionCard inside Message and suppresses plain summary body", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const card = sampleCard()
    const view = render(
      <QueryClientProvider client={client}>
        <Message
          m={{ id: "m_q1", type: "chat", grouped: false, content: "PLAIN_FALLBACK_SUMMARY", decisionCard: card }}
          viewerUserId="u_gus"
          onSubmitDecisionCard={vi.fn(async () => ({ replyToId: "m_q1" }))}
          onOpenThread={() => undefined}
        />
      </QueryClientProvider>,
    )
    expect(view.getByTestId(tid.decisionCard)).toBeVisible()
    expect(view.queryByText("PLAIN_FALLBACK_SUMMARY")).toBeNull()
    view.unmount()
  })

  it("keeps DecisionCard choices and profiles read-only in a Message even when callbacks are supplied", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const card = sampleCard()
    const message = {
      id: "m_inbox_decision",
      type: "chat" as const,
      grouped: false,
      decisionCard: { ...card, questions: card.questions.slice(0, 1) },
    }
    const onOpenProfile = vi.fn()
    const onSubmitDecisionCard = vi.fn(async () => ({ replyToId: message.id }))
    const row = (readOnly: boolean) => (
      <QueryClientProvider client={client}>
        <Message
          m={message}
          readOnly={readOnly}
          viewerUserId="u_gus"
          onOpenProfile={onOpenProfile}
          onSubmitDecisionCard={onSubmitDecisionCard}
        />
      </QueryClientProvider>
    )
    const view = render(row(true))

    expect(view.getByTestId(tid.decisionCard)).toBeVisible()
    const choice = () => view.getByTestId(tid.decisionCardOption("timing", "today"))
    expect(choice().querySelector('[role="radio"]')).toHaveAttribute("aria-disabled", "true")
    const assignee = () => view.getByText("@gus", { exact: true })
    expect(assignee().closest("button")).toBeNull()
    fireEvent.click(assignee())
    fireEvent.click(choice())
    expect(view.queryByTestId(tid.decisionCardSubmit)).toBeNull()
    expect(onOpenProfile).not.toHaveBeenCalled()
    expect(onSubmitDecisionCard).not.toHaveBeenCalled()

    view.rerender(row(false))
    expect(assignee().closest("button")).not.toBeNull()
    fireEvent.click(assignee())
    expect(onOpenProfile).toHaveBeenCalledExactlyOnceWith("gus", expect.anything(), "1813", "u_gus")
    fireEvent.click(choice())
    await act(async () => {
      fireEvent.click(view.getByTestId(tid.decisionCardSubmit))
    })
    expect(onSubmitDecisionCard).toHaveBeenCalledExactlyOnceWith(
      message.id,
      expect.stringContaining("Timing: Today"),
      expect.any(String),
    )
    view.unmount()
  })
})
