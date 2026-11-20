import { describe, expect, it } from "vitest";
import {
  DECISION_CARD_EMBED_KIND,
  DECISION_CARD_MAX_BYTES,
  DECISION_CARD_SUMMARY_MAX_BYTES,
  DecisionCardAnswerInputSchema,
  DecisionCardInputSchema,
  appendDecisionCardResponder,
  attachDecisionCardResponders,
  buildDecisionCardEmbed,
  extractDecisionCardFromEmbeds,
  formatDecisionCardAnswerMessage,
  formatDecisionCardSummary,
  mergeDecisionCardEmbeds,
  parseDecisionCardCliInput,
  toDecisionCardAgentPayload,
  validateDecisionCardAnswers,
} from "./community-decision-card";
import { CommunityAgentSendRequestSchema } from "./schemas";

describe("community-decision-card", () => {
  it("parses valid CLI input including string option shorthand and defaults", () => {
    const parsed = parseDecisionCardCliInput({
      mentions: ["@gus#1813"],
      summary: "Pick rollout timing",
      questions: [
        {
          header: "Timing",
          question: "When should we publish?",
          options: ["Today", { label: "Next week", description: "Hold for next release", recommended: true }],
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const embed = buildDecisionCardEmbed(parsed.data, [{ userId: "u_gus", handle: "gus#1813" }]);
    expect(embed).toEqual({
      kind: DECISION_CARD_EMBED_KIND,
      version: 1,
      summary: "Pick rollout timing",
      assignees: [{ userId: "u_gus", handle: "gus#1813" }],
      questions: [
        {
          id: "q1",
          header: "Timing",
          question: "When should we publish?",
          multiSelect: false,
          allowOther: true,
          options: [
            { id: "o1", label: "Today" },
            { id: "o2", label: "Next week", description: "Hold for next release", recommended: true },
          ],
        },
      ],
    });
    expect("title" in embed).toBe(false);
  });

  it("rejects out-of-bounds question/option counts, duplicate ids, and oversized payloads", () => {
    expect(DecisionCardInputSchema.safeParse({ questions: [] }).success).toBe(false);
    const badMention = DecisionCardInputSchema.safeParse({
      mentions: ["alice-no-tag"],
      questions: [{ question: "Q1", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(badMention.success).toBe(false);
    if (!badMention.success) {
      expect(badMention.error.issues[0]?.path).toEqual(["mentions", 0]);
    }
    expect(
      DecisionCardInputSchema.safeParse({
        questions: [
          { question: "Q1", options: [{ label: "Only one" }] },
        ],
      }).success,
    ).toBe(false);
    expect(
      DecisionCardInputSchema.safeParse({
        questions: [
          { id: "dup", question: "Q1", options: [{ label: "A" }, { label: "B" }] },
          { id: "dup", question: "Q2", options: [{ label: "A" }, { label: "B" }] },
        ],
      }).success,
    ).toBe(false);
    expect(
      DecisionCardInputSchema.safeParse({
        questions: [
          { question: "Q1", options: [{ id: "x", label: "A" }, { id: "x", label: "B" }] },
        ],
      }).success,
    ).toBe(false);

    const hugeOptions = Array.from({ length: 6 }, (_, i) => ({
      label: `Option ${i} ${"a".repeat(100)}`,
      description: "b".repeat(230),
    }));
    const oversized = {
      summary: "s".repeat(240),
      questions: Array.from({ length: 4 }, (_, q) => ({
        header: `Header ${q}`,
        question: "q".repeat(290),
        options: hugeOptions,
      })),
    };
    expect(JSON.stringify(oversized).length).toBeGreaterThan(DECISION_CARD_MAX_BYTES);
    expect(DecisionCardInputSchema.safeParse(oversized).success).toBe(false);
  });

  it("extracts decision card embed without disturbing unrelated embeds", () => {
    const parsed = DecisionCardInputSchema.parse({
      questions: [{ question: "Ship?", options: [{ label: "Yes" }, { label: "No" }] }],
    });
    const card = buildDecisionCardEmbed(parsed, []);
    const linkEmbed = { title: "Docs", url: "https://example.com" };
    const extracted = extractDecisionCardFromEmbeds([linkEmbed, card]);
    expect(extracted.card).toEqual(card);
    expect(extracted.otherEmbeds).toEqual([linkEmbed]);
  });

  it("formats readable summary and canonical reply text", () => {
    const parsed = DecisionCardInputSchema.parse({
      summary: "Need two calls",
      questions: [
        {
          id: "mode",
          header: "Mode",
          question: "Which mode?",
          options: [
            { id: "fast", label: "Fast", recommended: true },
            { id: "safe", label: "Safe" },
          ],
        },
        {
          id: "targets",
          header: "Targets",
          question: "Which platforms?",
          multiSelect: true,
          options: [
            { id: "web", label: "Web" },
            { id: "mac", label: "macOS" },
          ],
        },
      ],
    });
    const card = buildDecisionCardEmbed(parsed, [{ userId: "u1", handle: "gus#1813" }]);
    const summary = formatDecisionCardSummary(card);
    expect(summary).toBe("Need two calls");
    expect(summary).not.toContain("@gus#1813");
    expect(summary).not.toContain("Fast");
    expect(summary).not.toContain("[Mode]");

    expect(toDecisionCardAgentPayload({ ...card, respondedUserIds: ["u1"] })).toEqual({
      mentions: ["@gus#1813"],
      summary: "Need two calls",
      questions: card.questions,
    });

    const singleQuestionCard = buildDecisionCardEmbed(
      DecisionCardInputSchema.parse({
        questions: [{ question: "哪天开会？", options: [{ label: "周四", recommended: true }, { label: "周五" }] }],
      }),
      [],
    );
    expect(formatDecisionCardSummary(singleQuestionCard)).toBe("哪天开会？");
    expect(toDecisionCardAgentPayload(singleQuestionCard)).toEqual({
      questions: singleQuestionCard.questions,
    });

    const multiNoSummaryCard = buildDecisionCardEmbed(
      DecisionCardInputSchema.parse({
        questions: [
          { question: "哪天开会？", options: [{ label: "周四" }, { label: "周五" }] },
          { question: "包含哪些模块？", options: [{ label: "Web" }, { label: "Daemon" }] },
        ],
      }),
      [],
    );
    expect(formatDecisionCardSummary(multiNoSummaryCard)).toBe("1. 哪天开会？ 2. 包含哪些模块？");

    // Non-handle fallback assignees (e.g. raw internal userId in DM when peer profile was missing) must never leak as mentions.
    const rawIdFallbackCard = buildDecisionCardEmbed(
      DecisionCardInputSchema.parse({
        questions: [{ question: "Ship?", options: [{ label: "Yes" }, { label: "No" }] }],
      }),
      [{ userId: "usr_internal_1", handle: "usr_internal_1" }],
    );
    expect(toDecisionCardAgentPayload(rawIdFallbackCard)).toEqual({
      questions: rawIdFallbackCard.questions,
    });
    expect(toDecisionCardAgentPayload(rawIdFallbackCard)).not.toHaveProperty("mentions");

    const answerInput = DecisionCardAnswerInputSchema.parse({
      answers: [
        { questionId: "mode", selectedOptionIds: ["fast"] },
        { questionId: "targets", selectedOptionIds: ["web", "mac"], otherText: "iOS later" },
      ],
    });
    const validated = validateDecisionCardAnswers(card, answerInput);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(formatDecisionCardAnswerMessage(card, validated.resolved)).toBe(
      "1. Mode: Fast\n2. Targets: Web, macOS, Other: iOS later",
    );
  });

  it("validates single-select, allowOther=false, missing, duplicate, and unknown answers", () => {
    const card = buildDecisionCardEmbed(
      DecisionCardInputSchema.parse({
        questions: [
          {
            id: "q1",
            question: "Pick one",
            allowOther: false,
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
        ],
      }),
      [],
    );

    expect(validateDecisionCardAnswers(card, { answers: [{ questionId: "q1", selectedOptionIds: ["a", "b"] }] }).ok).toBe(false);
    expect(validateDecisionCardAnswers(card, { answers: [{ questionId: "q1", otherText: "custom" }] }).ok).toBe(false);
    expect(validateDecisionCardAnswers(card, { answers: [{ questionId: "q1", selectedOptionIds: ["unknown"] }] }).ok).toBe(false);
    expect(validateDecisionCardAnswers(card, { answers: [{ questionId: "missing", selectedOptionIds: ["a"] }] }).ok).toBe(false);
    expect(validateDecisionCardAnswers(card, { answers: [{ questionId: "q1", selectedOptionIds: [] }] }).ok).toBe(false);
    expect(validateDecisionCardAnswers(card, { answers: [{ questionId: "q1", selectedOptionIds: ["a"] }] }).ok).toBe(true);
  });

  it("extends CommunityAgentSendRequestSchema cleanly for question cards", () => {
    const ok = CommunityAgentSendRequestSchema.safeParse({
      channel: "/demo#1234/general",
      content: { text: "" },
      question: {
        questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "Wait" }] }],
      },
    });
    expect(ok.success).toBe(true);

    const withAttachment = CommunityAgentSendRequestSchema.safeParse({
      channel: "/demo#1234/general",
      content: { text: "" },
      attachments: ["att-1"],
      question: {
        questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "Wait" }] }],
      },
    });
    expect(withAttachment.success).toBe(false);

    const withBodyText = CommunityAgentSendRequestSchema.safeParse({
      channel: "/demo#1234/general",
      content: { text: "extra" },
      question: {
        questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "Wait" }] }],
      },
    });
    expect(withBodyText.success).toBe(false);
  });

  it("bounds readable summary via message preview truncation and preserves checked-zero vs unchecked responder states", () => {
    const cjkCard = buildDecisionCardEmbed(
      DecisionCardInputSchema.parse({
        summary: "请确认以下四个发布问题并选择最合适的执行策略".repeat(8),
        questions: Array.from({ length: 4 }, (_, i) => ({
          header: `问题${i + 1}`,
          question: `第${i + 1}个需要决策的详细问题说明，包含完整上下文与约束条件。`.repeat(3),
          options: [
            { label: "方案一：立即全量发布并同步开启监控" },
            { label: "方案二：先灰度一部分流量再逐步放开" },
          ],
        })),
      }),
      [{ userId: "u1", handle: "gus#1813" }],
    );
    const summary = formatDecisionCardSummary(cjkCard);
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(new TextEncoder().encode(summary).byteLength).toBeLessThanOrEqual(DECISION_CARD_SUMMARY_MAX_BYTES);
    expect(summary.endsWith("…")).toBe(true);

    // Checked zero responders is distinct from unchecked undefined.
    const checkedZero = attachDecisionCardResponders([cjkCard], []);
    expect(extractDecisionCardFromEmbeds(checkedZero).card?.respondedUserIds).toEqual([]);
    const unchecked = attachDecisionCardResponders([cjkCard], undefined);
    expect(extractDecisionCardFromEmbeds(unchecked).card?.respondedUserIds).toBeUndefined();

    // Unchecked incoming embed preserves previously hydrated responders; checked incoming updates them.
    const hydrated = attachDecisionCardResponders([cjkCard], ["u_a"]);
    const mergedWithUnchecked = mergeDecisionCardEmbeds(hydrated, [cjkCard]);
    expect(extractDecisionCardFromEmbeds(mergedWithUnchecked).card?.respondedUserIds).toEqual(["u_a"]);

    const mergedWithFreshZero = mergeDecisionCardEmbeds(hydrated, checkedZero);
    expect(extractDecisionCardFromEmbeds(mergedWithFreshZero).card?.respondedUserIds).toEqual([]);

    const appended = appendDecisionCardResponder(hydrated, "u_b");
    expect(extractDecisionCardFromEmbeds(appended).card?.respondedUserIds).toEqual(["u_a", "u_b"]);
    expect(appendDecisionCardResponder(appended, "u_b")).toBeUndefined();
  });
});
