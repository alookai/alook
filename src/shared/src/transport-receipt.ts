function isAttemptCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Parse a rolling transport-attempt receipt. `sent` is a temporary wire
 * alias for independently deployed legacy consumers; it never means that
 * the command was received or completed.
 */
export function parseAttemptedCountReceipt(
  value: unknown,
  options: { allowLegacySentOnly?: boolean } = {},
): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid attempted-count receipt");
  }
  const data = value as Record<string, unknown>;
  const hasAttempted = Object.prototype.hasOwnProperty.call(data, "attempted");
  const hasSent = Object.prototype.hasOwnProperty.call(data, "sent");
  if (hasAttempted) {
    if (!isAttemptCount(data.attempted)) throw new Error("invalid attempted count");
    if (hasSent && (!isAttemptCount(data.sent) || data.sent !== data.attempted)) {
      throw new Error("inconsistent attempted-count receipt");
    }
    return data.attempted;
  }
  if (hasSent && isAttemptCount(data.sent) && options.allowLegacySentOnly !== false) return data.sent;
  throw new Error("missing attempted count");
}
