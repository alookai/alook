import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import styles from "./hand-accent.module.css"

/** The brand's hand-written accent: one key word of a title, in Caveat and
 * brand blue (technostalgia). One implementation for every page title. */
export function HandAccent({ children, className }: { children: ReactNode; className?: string }) {
  return <span data-slot="hand-accent" className={cn(styles.accent, className)}>{children}</span>
}
