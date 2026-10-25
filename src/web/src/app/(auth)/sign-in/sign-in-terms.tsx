"use client"

import { useEffect, useRef } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useIsMobile } from "@/hooks/use-mobile"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { handleMessageExternalLinkClick } from "@/components/community/messages/message-external-link"

function PolicyLinks() {
  const linkClass = "underline underline-offset-3 hover:text-foreground"
  return <>
    I agree to the <a href="/terms" target="_blank" rel="noopener noreferrer" className={linkClass} onClick={event => { void handleMessageExternalLinkClick(event, event.currentTarget.href) }}>Terms of Service</a>.
    {" "}See our <a href="/privacy" target="_blank" rel="noopener noreferrer" className={linkClass} onClick={event => { void handleMessageExternalLinkClick(event, event.currentTarget.href) }}>Privacy Policy</a>.
  </>
}

export function useSignInTerms() {
  const [accepted, setAccepted] = useAtom(useCreateAtom(false))
  const [open, setOpen] = useAtom(useCreateAtom(false))
  const [reminder, setReminder] = useAtom(useCreateAtom(false))
  const pending = useRef<(() => void) | null>(null)
  const checkbox = useRef<HTMLInputElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const mobile = useIsMobile()

  useEffect(() => () => { pending.current = null }, [])

  const requestConsent = (continueSignIn: () => void) => {
    if (accepted) {
      continueSignIn()
      return
    }
    if (mobile) {
      pending.current = continueSignIn
      setOpen(true)
      return
    }
    setReminder(true)
    checkbox.current?.focus()
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      area.current?.animate?.([
        { transform: "translateX(0)" },
        { transform: "translateX(-6px)" },
        { transform: "translateX(6px)" },
        { transform: "translateX(-4px)" },
        { transform: "translateX(0)" },
      ], { duration: 280, easing: "ease-in-out" })
    }
  }

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) pending.current = null
  }
  const confirm = () => {
    const continuation = pending.current
    pending.current = null
    setAccepted(true)
    setReminder(false)
    setOpen(false)
    continuation?.()
  }

  return {
    requestConsent,
    control: <>
      <div ref={area} className="space-y-2" data-testid="sign-in-terms">
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <label className="grid size-11 shrink-0 cursor-pointer place-items-center" htmlFor="sign-in-terms-checkbox">
          <input id="sign-in-terms-checkbox" ref={checkbox} type="checkbox" className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            checked={accepted} onChange={event => { setAccepted(event.target.checked); setReminder(false) }}
            aria-label="I agree to the Terms of Service" aria-invalid={reminder || undefined}
            aria-describedby={reminder ? "sign-in-terms-reminder" : undefined} />
          </label>
          <span className="py-2"><PolicyLinks /></span>
        </div>
        {reminder && <p id="sign-in-terms-reminder" role="alert" className="text-sm text-destructive">Please agree to the Terms of Service to continue.</p>}
      </div>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Agree to continue</DialogTitle>
            <DialogDescription><PolicyLinks /></DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-11" data-testid="sign-in-terms-cancel" onClick={() => changeOpen(false)}>Cancel</Button>
            <Button type="button" className="h-11" data-testid="sign-in-terms-confirm" onClick={confirm}>Agree and continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>,
  }
}
