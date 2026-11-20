import { z } from "zod";
import { MAX_MESSAGE_CONTENT_LENGTH } from "./constants/community";
import { parseNameAndTag } from "./lib/discriminator";

export const DECISION_CARD_MESSAGE_TYPE = "question" as const;
export const DECISION_CARD_EMBED_KIND = "decision_card" as const;
export const DECISION_CARD_EMBED_VERSION = 1 as const;

export const DECISION_CARD_MAX_BYTES = 8 * 1024;
export const DECISION_CARD_SUMMARY_MAX_BYTES = 1024;
export const DECISION_CARD_MAX_MENTIONS = 20;
export const DECISION_CARD_MIN_QUESTIONS = 1;
export const DECISION_CARD_MAX_QUESTIONS = 4;
export const DECISION_CARD_MIN_OPTIONS = 2;
export const DECISION_CARD_MAX_OPTIONS = 6;
export const DECISION_CARD_ID_MAX_LENGTH = 40;
export const DECISION_CARD_SUMMARY_MAX_LENGTH = 240;
export const DECISION_CARD_HEADER_MAX_LENGTH = 24;
export const DECISION_CARD_QUESTION_MAX_LENGTH = 300;
export const DECISION_CARD_OPTION_LABEL_MAX_LENGTH = 120;
export const DECISION_CARD_OPTION_DESC_MAX_LENGTH = 240;
export const DECISION_CARD_OTHER_TEXT_MAX_LENGTH = 500;

export function decisionCardUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const idFieldSchema = z
  .string()
  .trim()
  .min(1)
  .max(DECISION_CARD_ID_MAX_LENGTH)
  .regex(/^[a-zA-Z0-9_-]+$/, "id must contain only letters, digits, hyphens, or underscores");

const optionalTrimmedText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length > 0 ? value : undefined))
    .optional();

export const DecisionCardOptionInputSchema = z.strictObject({
  id: idFieldSchema.optional(),
  label: z.string().trim().min(1).max(DECISION_CARD_OPTION_LABEL_MAX_LENGTH),
  description: optionalTrimmedText(DECISION_CARD_OPTION_DESC_MAX_LENGTH),
  recommended: z.boolean().optional(),
});
export type DecisionCardOptionInput = z.infer<typeof DecisionCardOptionInputSchema>;

export const DecisionCardQuestionInputSchema = z.strictObject({
  id: idFieldSchema.optional(),
  header: optionalTrimmedText(DECISION_CARD_HEADER_MAX_LENGTH),
  question: z.string().trim().min(1).max(DECISION_CARD_QUESTION_MAX_LENGTH),
  multiSelect: z.boolean().optional(),
  allowOther: z.boolean().optional(),
  options: z
    .array(DecisionCardOptionInputSchema)
    .min(DECISION_CARD_MIN_OPTIONS)
    .max(DECISION_CARD_MAX_OPTIONS),
});
export type DecisionCardQuestionInput = z.infer<typeof DecisionCardQuestionInputSchema>;

function hasDuplicateIds(ids: readonly string[]): boolean {
  return new Set(ids).size !== ids.length;
}

const mentionHandleSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (value) => parseNameAndTag(value.startsWith("@") ? value.slice(1) : value) !== null,
    { message: 'mention must be a handle like "@alice#0001"' },
  );

export const DecisionCardInputSchema = z
  .strictObject({
    mentions: z
      .array(mentionHandleSchema)
      .max(DECISION_CARD_MAX_MENTIONS)
      .optional(),
    summary: optionalTrimmedText(DECISION_CARD_SUMMARY_MAX_LENGTH),
    questions: z
      .array(DecisionCardQuestionInputSchema)
      .min(DECISION_CARD_MIN_QUESTIONS)
      .max(DECISION_CARD_MAX_QUESTIONS),
  })
  .superRefine((value, ctx) => {
    const qIds = value.questions.map((q, index) => q.id ?? `q${index + 1}`);
    if (hasDuplicateIds(qIds)) {
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: "question ids must be unique",
      });
    }
    value.questions.forEach((q, qIndex) => {
      const optIds = q.options.map((opt, oIndex) => opt.id ?? `o${oIndex + 1}`);
      if (hasDuplicateIds(optIds)) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", qIndex, "options"],
          message: "option ids must be unique within a question",
        });
      }
    });
    if (decisionCardUtf8Bytes(value) > DECISION_CARD_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: `decision card exceeds ${DECISION_CARD_MAX_BYTES} bytes`,
      });
    }
  });
export type DecisionCardInput = z.infer<typeof DecisionCardInputSchema>;

const DecisionCardCliOptionSchema = z.union([
  z.string().trim().min(1).max(DECISION_CARD_OPTION_LABEL_MAX_LENGTH).transform((label) => ({ label })),
  DecisionCardOptionInputSchema,
]);

const DecisionCardCliInputSchema = z.strictObject({
  mentions: z
    .array(mentionHandleSchema)
    .max(DECISION_CARD_MAX_MENTIONS)
    .optional(),
  summary: optionalTrimmedText(DECISION_CARD_SUMMARY_MAX_LENGTH),
  questions: z
    .array(
      z.strictObject({
        id: idFieldSchema.optional(),
        header: optionalTrimmedText(DECISION_CARD_HEADER_MAX_LENGTH),
        question: z.string().trim().min(1).max(DECISION_CARD_QUESTION_MAX_LENGTH),
        multiSelect: z.boolean().optional(),
        allowOther: z.boolean().optional(),
        options: z
          .array(DecisionCardCliOptionSchema)
          .min(DECISION_CARD_MIN_OPTIONS)
          .max(DECISION_CARD_MAX_OPTIONS),
      }),
    )
    .min(DECISION_CARD_MIN_QUESTIONS)
    .max(DECISION_CARD_MAX_QUESTIONS),
});

export function parseDecisionCardCliInput(raw: unknown): z.ZodSafeParseResult<DecisionCardInput> {
  const pre = DecisionCardCliInputSchema.safeParse(raw);
  if (!pre.success) return pre as z.ZodSafeParseResult<DecisionCardInput>;
  return DecisionCardInputSchema.safeParse(pre.data);
}

export const DecisionCardAssigneeSchema = z.strictObject({
  userId: z.string().min(1),
  handle: z.string().min(1),
});
export type DecisionCardAssignee = z.infer<typeof DecisionCardAssigneeSchema>;

export const DecisionCardNormalizedOptionSchema = z.strictObject({
  id: idFieldSchema,
  label: z.string().trim().min(1).max(DECISION_CARD_OPTION_LABEL_MAX_LENGTH),
  description: z.string().trim().min(1).max(DECISION_CARD_OPTION_DESC_MAX_LENGTH).optional(),
  recommended: z.boolean().optional(),
});
export type DecisionCardNormalizedOption = z.infer<typeof DecisionCardNormalizedOptionSchema>;

export const DecisionCardNormalizedQuestionSchema = z.strictObject({
  id: idFieldSchema,
  header: z.string().trim().min(1).max(DECISION_CARD_HEADER_MAX_LENGTH).optional(),
  question: z.string().trim().min(1).max(DECISION_CARD_QUESTION_MAX_LENGTH),
  multiSelect: z.boolean(),
  allowOther: z.boolean(),
  options: z
    .array(DecisionCardNormalizedOptionSchema)
    .min(DECISION_CARD_MIN_OPTIONS)
    .max(DECISION_CARD_MAX_OPTIONS),
});
export type DecisionCardNormalizedQuestion = z.infer<typeof DecisionCardNormalizedQuestionSchema>;

// Deliberately omits `title` so older clients' `MessageEmbedSchema` ignores this
// embed cleanly and falls back to rendering `message.content`.
export const DecisionCardEmbedSchema = z.strictObject({
  kind: z.literal(DECISION_CARD_EMBED_KIND),
  version: z.literal(DECISION_CARD_EMBED_VERSION),
  summary: z.string().trim().min(1).max(DECISION_CARD_SUMMARY_MAX_LENGTH).optional(),
  assignees: z.array(DecisionCardAssigneeSchema).max(DECISION_CARD_MAX_MENTIONS),
  questions: z
    .array(DecisionCardNormalizedQuestionSchema)
    .min(DECISION_CARD_MIN_QUESTIONS)
    .max(DECISION_CARD_MAX_QUESTIONS),
  respondedUserIds: z.array(z.string().min(1)).optional(),
});
export type DecisionCardEmbed = z.infer<typeof DecisionCardEmbedSchema>;

export function attachDecisionCardResponders(
  embeds: readonly unknown[] | undefined,
  respondedUserIds: readonly string[] | undefined,
): unknown[] | undefined {
  if (!embeds || embeds.length === 0) {
    return embeds ? [...embeds] : undefined;
  }
  if (respondedUserIds === undefined) {
    return [...embeds];
  }
  const uniqueResponders = [...new Set(respondedUserIds.filter((id) => id.length > 0))];
  let attached = false;
  return embeds.map((item) => {
    if (
      !attached
      && item
      && typeof item === "object"
      && !Array.isArray(item)
      && (item as { kind?: unknown }).kind === DECISION_CARD_EMBED_KIND
    ) {
      const parsed = DecisionCardEmbedSchema.safeParse(item);
      if (parsed.success) {
        attached = true;
        return { ...parsed.data, respondedUserIds: uniqueResponders };
      }
    }
    return item;
  });
}

export function mergeDecisionCardEmbeds(
  previousEmbeds: readonly unknown[] | undefined,
  incomingEmbeds: readonly unknown[] | undefined,
): unknown[] | undefined {
  if (!incomingEmbeds || incomingEmbeds.length === 0) return incomingEmbeds ? [...incomingEmbeds] : undefined;
  const previousCard = extractDecisionCardFromEmbeds(previousEmbeds).card;
  if (!previousCard || previousCard.respondedUserIds === undefined) return [...incomingEmbeds];
  const incomingCard = extractDecisionCardFromEmbeds(incomingEmbeds).card;
  if (!incomingCard || incomingCard.respondedUserIds !== undefined) return [...incomingEmbeds];
  return attachDecisionCardResponders(incomingEmbeds, previousCard.respondedUserIds);
}

export function appendDecisionCardResponder(
  embeds: readonly unknown[] | undefined,
  responderUserId: string,
): unknown[] | undefined {
  if (!embeds || embeds.length === 0 || !responderUserId) return undefined;
  const card = extractDecisionCardFromEmbeds(embeds).card;
  if (!card) return undefined;
  if (card.respondedUserIds?.includes(responderUserId)) return undefined;
  return attachDecisionCardResponders(embeds, [...(card.respondedUserIds ?? []), responderUserId]);
}

export function buildDecisionCardEmbed(
  input: DecisionCardInput,
  assignees: readonly DecisionCardAssignee[],
): DecisionCardEmbed {
  return DecisionCardEmbedSchema.parse({
    kind: DECISION_CARD_EMBED_KIND,
    version: DECISION_CARD_EMBED_VERSION,
    ...(input.summary ? { summary: input.summary } : {}),
    assignees: assignees.map((assignee) => ({
      userId: assignee.userId,
      handle: assignee.handle,
    })),
    questions: input.questions.map((question, qIndex) => ({
      id: question.id ?? `q${qIndex + 1}`,
      ...(question.header ? { header: question.header } : {}),
      question: question.question,
      multiSelect: question.multiSelect === true,
      allowOther: question.allowOther !== false,
      options: question.options.map((option, oIndex) => ({
        id: option.id ?? `o${oIndex + 1}`,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        ...(option.recommended === true ? { recommended: true } : {}),
      })),
    })),
  });
}

export function extractDecisionCardFromEmbeds(embeds: readonly unknown[] | undefined): {
  card?: DecisionCardEmbed;
  otherEmbeds?: unknown[];
} {
  if (!embeds || embeds.length === 0) return {};
  let card: DecisionCardEmbed | undefined;
  const other: unknown[] = [];
  for (const item of embeds) {
    if (
      !card
      && item
      && typeof item === "object"
      && !Array.isArray(item)
      && (item as { kind?: unknown }).kind === DECISION_CARD_EMBED_KIND
    ) {
      const parsed = DecisionCardEmbedSchema.safeParse(item);
      if (parsed.success) {
        card = parsed.data;
        continue;
      }
    }
    other.push(item);
  }
  return {
    ...(card ? { card } : {}),
    ...(other.length > 0 ? { otherEmbeds: other } : {}),
  };
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const ellipsisBytes = encoder.encode("…").byteLength;
  if (maxBytes <= ellipsisBytes) return "…";
  const budget = maxBytes - ellipsisBytes;
  let out = "";
  let used = 0;
  for (const ch of value) {
    const chBytes = encoder.encode(ch).byteLength;
    if (used + chBytes > budget) break;
    out += ch;
    used += chBytes;
  }
  return `${out.trimEnd()}…`;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return "…";
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

export function formatDecisionCardSummary(
  card: DecisionCardEmbed,
  maxBytes: number = DECISION_CARD_SUMMARY_MAX_BYTES,
): string {
  const lines: string[] = [];
  const mentionLine = card.assignees.map((assignee) => `@${assignee.handle}`).join(" ");
  if (mentionLine && card.summary) {
    lines.push(`${mentionLine} ${card.summary}`);
  } else if (mentionLine) {
    lines.push(mentionLine);
  } else if (card.summary) {
    lines.push(card.summary);
  }

  const numbered = card.questions.length > 1;
  card.questions.forEach((question, index) => {
    const prefix = numbered ? `${index + 1}. ` : "";
    const tag = question.header ? `[${question.header}] ` : "";
    lines.push(`${prefix}${tag}${question.question}`);
    const optionSummary = question.options
      .map((option) => (option.recommended ? `${option.label} (Recommended)` : option.label))
      .join(" / ");
    lines.push(`   ${optionSummary}${question.allowOther ? " / Other" : ""}`);
  });

  return truncateUtf8Bytes(lines.join("\n"), maxBytes);
}

export const DecisionCardAnswerItemSchema = z.strictObject({
  questionId: idFieldSchema,
  selectedOptionIds: z.array(idFieldSchema).max(DECISION_CARD_MAX_OPTIONS).optional(),
  otherText: z.string().trim().max(DECISION_CARD_OTHER_TEXT_MAX_LENGTH).optional(),
});
export type DecisionCardAnswerItem = z.infer<typeof DecisionCardAnswerItemSchema>;

export const DecisionCardAnswerInputSchema = z.strictObject({
  answers: z
    .array(DecisionCardAnswerItemSchema)
    .min(DECISION_CARD_MIN_QUESTIONS)
    .max(DECISION_CARD_MAX_QUESTIONS),
});
export type DecisionCardAnswerInput = z.infer<typeof DecisionCardAnswerInputSchema>;

export interface ResolvedDecisionAnswer {
  questionId: string;
  header?: string;
  question: string;
  selectedLabels: string[];
  otherText?: string;
}

export type DecisionCardAnswerValidationResult =
  | { ok: true; resolved: ResolvedDecisionAnswer[] }
  | { ok: false; error: string };

export function validateDecisionCardAnswers(
  card: DecisionCardEmbed,
  input: DecisionCardAnswerInput,
): DecisionCardAnswerValidationResult {
  const byQuestionId = new Map<string, DecisionCardAnswerItem>();
  for (const answer of input.answers) {
    if (byQuestionId.has(answer.questionId)) {
      return { ok: false, error: `duplicate answer for question "${answer.questionId}"` };
    }
    byQuestionId.set(answer.questionId, answer);
  }

  const cardQuestionIds = new Set(card.questions.map((q) => q.id));
  for (const questionId of byQuestionId.keys()) {
    if (!cardQuestionIds.has(questionId)) {
      return { ok: false, error: `unknown question "${questionId}"` };
    }
  }

  const resolved: ResolvedDecisionAnswer[] = [];
  for (const question of card.questions) {
    const answer = byQuestionId.get(question.id);
    if (!answer) {
      return { ok: false, error: `missing answer for "${question.header ?? question.question}"` };
    }

    const rawSelected = answer.selectedOptionIds ?? [];
    if (hasDuplicateIds(rawSelected)) {
      return { ok: false, error: `duplicate option selection in "${question.id}"` };
    }

    const optionById = new Map(question.options.map((opt) => [opt.id, opt]));
    const selectedLabels: string[] = [];
    for (const optionId of rawSelected) {
      const option = optionById.get(optionId);
      if (!option) {
        return { ok: false, error: `invalid option "${optionId}" for question "${question.id}"` };
      }
      selectedLabels.push(option.label);
    }

    const otherText = answer.otherText?.trim() ? answer.otherText.trim() : undefined;
    if (otherText && !question.allowOther) {
      return { ok: false, error: `custom answer is not allowed for question "${question.id}"` };
    }

    const totalChoices = selectedLabels.length + (otherText ? 1 : 0);
    if (totalChoices === 0) {
      return { ok: false, error: `choose an answer for "${question.header ?? question.question}"` };
    }
    if (!question.multiSelect && totalChoices > 1) {
      return { ok: false, error: `only one option is allowed for "${question.header ?? question.question}"` };
    }

    resolved.push({
      questionId: question.id,
      ...(question.header ? { header: question.header } : {}),
      question: question.question,
      selectedLabels,
      ...(otherText ? { otherText } : {}),
    });
  }

  return { ok: true, resolved };
}

export function formatDecisionCardAnswerMessage(
  card: DecisionCardEmbed,
  resolved: readonly ResolvedDecisionAnswer[],
  maxLength: number = MAX_MESSAGE_CONTENT_LENGTH,
): string {
  const single = card.questions.length === 1 && resolved.length === 1;
  const lines = resolved.map((entry, index) => {
    const parts = [...entry.selectedLabels];
    if (entry.otherText) parts.push(`Other: ${entry.otherText}`);
    const answerText = parts.join(", ");
    const label = entry.header ?? entry.question;
    return single ? `${label}: ${answerText}` : `${index + 1}. ${label}: ${answerText}`;
  });
  return truncateText(lines.join("\n"), maxLength);
}
