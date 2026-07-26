import { customAlphabet } from "nanoid";

const slugId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz");

export function generateWorkspaceSlug(): string {
  return `company-${slugId(8)}`;
}

/**
 * Normalize an arbitrary string into a URL-safe workspace slug: ASCII
 * kebab-case, lowercase, runs of anything outside `[a-z0-9]` collapse to a
 * single `-`, no leading/trailing `-`, capped at 60 chars (with the trailing
 * `-` a mid-run truncation may leave stripped again). Input that has no
 * `[a-z0-9]` characters (e.g. `"总部"`, `"!!!"`, `""`) returns `""` — callers
 * must treat empty as "generate a fallback" (create) or "reject" (update).
 */
export function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** Lowercase-alnum id for slug conflict-retry suffixes. */
export const slugSuffix = slugId;
