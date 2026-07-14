export type AgentVisibility = "public" | "private"

export function isPublic(visibility: string | null | undefined): boolean {
  return visibility === "public"
}

export function isPrivate(visibility: string | null | undefined): boolean {
  return visibility === "private"
}
