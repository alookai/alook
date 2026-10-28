"use client"

import type { ChangeEventHandler, Ref } from "react"
import { handleMessageExternalLinkClick } from "@/components/community/messages/message-external-link"

export function PolicyLinks() {
  const linkClass = "underline underline-offset-3 hover:text-foreground"
  return <>
    I agree to the <a href="/terms" target="_blank" rel="noopener noreferrer" className={linkClass} onClick={event => { void handleMessageExternalLinkClick(event, event.currentTarget.href) }}>Terms of Service</a>.
    {" "}See our <a href="/privacy" target="_blank" rel="noopener noreferrer" className={linkClass} onClick={event => { void handleMessageExternalLinkClick(event, event.currentTarget.href) }}>Privacy Policy</a>.
  </>
}

export function SignInTermsControl({ accepted = false, reminder = false, onChange, areaRef, checkboxRef, id = "sign-in-terms" }: {
  accepted?: boolean
  reminder?: boolean
  onChange?: ChangeEventHandler<HTMLInputElement>
  areaRef?: Ref<HTMLDivElement>
  checkboxRef?: Ref<HTMLInputElement>
  id?: string
}) {
  return (
      <div ref={areaRef} className="space-y-2" data-testid="sign-in-terms">
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <label className="-mx-3.5 grid size-11 shrink-0 cursor-pointer place-items-center" htmlFor={`${id}-checkbox`}>
          <input id={`${id}-checkbox`} ref={checkboxRef} type="checkbox" className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            checked={accepted} readOnly={!onChange} onChange={onChange}
            aria-label="I agree to the Terms of Service" aria-invalid={reminder || undefined}
            aria-describedby={reminder ? `${id}-copy` : undefined} />
          </label>
          <span id={`${id}-copy`} role={reminder ? "alert" : undefined} className={`py-2${reminder ? " text-destructive" : ""}`}><PolicyLinks /></span>
        </div>
      </div>
  )
}
