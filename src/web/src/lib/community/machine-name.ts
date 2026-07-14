export function machineName(m?: {
  displayName?: string | null
  hostname?: string | null
} | null): string {
  return m?.displayName?.trim() || m?.hostname?.trim() || "Unnamed machine"
}
