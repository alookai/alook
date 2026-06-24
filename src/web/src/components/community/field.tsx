import type React from "react"

// Labeled form field wrapper. Local to community — distinct from `@/components/ui/field`.
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </label>
  )
}
