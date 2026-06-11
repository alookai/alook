import { nanoid } from "nanoid";

export function generateWorkspaceSlug(): string {
  return `company-${nanoid(8)}`;
}
