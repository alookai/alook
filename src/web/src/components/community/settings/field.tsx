import type React from "react"

// Labeled form field wrapper. Local to community — distinct from `@/components/ui/field`.
export function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-xs text-muted-foreground">{label}</legend>
      {children}
    </fieldset>
  )
}
