"use client"

import { useEffect, useState, type ComponentPropsWithoutRef } from "react"
import { LoaderCircle } from "lucide-react"
import styles from "./document-navigation-link.module.css"

export function DocumentNavigationLink({ children, className, onClick, ...props }: ComponentPropsWithoutRef<"a">) {
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!pending) return
    const reset = () => setPending(false)
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") reset() }
    window.addEventListener("pageshow", reset)
    window.addEventListener("keydown", cancel)
    return () => {
      window.removeEventListener("pageshow", reset)
      window.removeEventListener("keydown", cancel)
    }
  }, [pending])

  return (
    <a {...props} className={`${className ?? ""} ${styles.link}`} aria-busy={pending || undefined}
      onClick={event => {
        onClick?.(event)
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        if (!props.href || (props.target && props.target !== "_self") || (props.download !== undefined && props.download !== false)) return
        setPending(true)
      }}>
      <span className={styles.content} style={{ visibility: pending ? "hidden" : undefined }}>{children}</span>
      {pending && <span className={styles.pending} role="status"><LoaderCircle aria-hidden="true" className={styles.spinner} />Opening…</span>}
    </a>
  )
}
