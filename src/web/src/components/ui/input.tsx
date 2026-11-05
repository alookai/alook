import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

const INPUT_VARIANTS = {
  // Boxed field for forms.
  default:
    "h-8 rounded-lg border border-input bg-transparent px-2 py-1 text-base focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:bg-input/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 sm:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  // Open title field (bot name, channel name, post title): no box; the
  // caller sets the type size. Same element, behaviour and theme hooks.
  frameless:
    "border-0 bg-transparent px-0 py-1 shadow-none placeholder:font-normal placeholder:text-muted-foreground/40 focus-visible:ring-0",
} as const

type InputVariant = keyof typeof INPUT_VARIANTS

function Input({ className, type, variant = "default", ...props }: React.ComponentProps<"input"> & { variant?: InputVariant }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      data-variant={variant}
      className={cn(
        "w-full min-w-0 transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        INPUT_VARIANTS[variant],
        className
      )}
      {...props}
    />
  )
}

export { Input }
export type { InputVariant }
