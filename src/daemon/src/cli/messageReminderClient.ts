import { readFileSync } from "node:fs";

export const LOCAL_MESSAGE_REMINDER_PATH = "/__alook/local/message-reminder";
const MIN_REMINDER_MS = 60_000;
const MAX_REMINDER_MS = 24 * 60 * 60_000;

export interface LocalMessageReminderInput {
  channel: string;
  sentSeq: number;
  remindAfterMs: number;
}

export type LocalMessageReminderResult =
  | { armed: true; dueAt: number }
  | { armed: false; reason: string };

export function parseRemindAfter(value: string): number {
  if (value === "0") return 0;
  const match = /^(\d+)(m|h)$/.exec(value);
  if (!match) {
    throw new Error("message send: --remind-after must be 0 or a positive integer followed by m or h (1m..24h)");
  }
  const amount = Number(match[1]);
  const milliseconds = amount * (match[2] === "h" ? 60 * 60_000 : 60_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < MIN_REMINDER_MS || milliseconds > MAX_REMINDER_MS) {
    throw new Error("message send: --remind-after must be 0 or between 1m and 24h");
  }
  return milliseconds;
}

export async function armMessageReminderFromEnv(
  input: LocalMessageReminderInput,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalMessageReminderResult> {
  const proxyUrl = env.ALOOK_PROXY_URL;
  const tokenFile = env.ALOOK_PROXY_TOKEN_FILE;
  if (!proxyUrl || !tokenFile) {
    return { armed: false, reason: "local reminder proxy unavailable" };
  }

  let voucher: string;
  try {
    voucher = readFileSync(tokenFile, "utf8").trim();
  } catch {
    return { armed: false, reason: "local reminder voucher unavailable" };
  }
  if (!voucher) return { armed: false, reason: "local reminder voucher unavailable" };

  let response: Response;
  try {
    response = await fetchImpl(`${proxyUrl.replace(/\/+$/, "")}${LOCAL_MESSAGE_REMINDER_PATH}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${voucher}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    return { armed: false, reason: "local reminder request failed" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { armed: false, reason: "local reminder returned an invalid response" };
  }
  if (!response.ok) {
    const code =
      typeof body === "object" && body !== null && typeof (body as { code?: unknown }).code === "string"
        ? (body as { code: string }).code
        : `http_${response.status}`;
    return { armed: false, reason: `local reminder rejected (${code})` };
  }
  if (
    typeof body === "object" &&
    body !== null &&
    (body as { armed?: unknown }).armed === true &&
    Number.isSafeInteger((body as { dueAt?: unknown }).dueAt)
  ) {
    return { armed: true, dueAt: (body as { dueAt: number }).dueAt };
  }
  if (
    typeof body === "object" &&
    body !== null &&
    (body as { armed?: unknown }).armed === false &&
    typeof (body as { reason?: unknown }).reason === "string"
  ) {
    return { armed: false, reason: (body as { reason: string }).reason };
  }
  return { armed: false, reason: "local reminder returned an invalid response" };
}
