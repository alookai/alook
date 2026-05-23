import { nanoid } from "nanoid";

export function generateWorkspaceSlug(): string {
  return `studio-${nanoid(8)}`;
}
