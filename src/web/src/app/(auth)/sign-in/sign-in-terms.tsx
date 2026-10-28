"use client"

import { useEffect, useRef } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useIsMobile } from "@/hooks/use-mobile"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { PolicyLinks, SignInTermsControl } from "./sign-in-terms-control"


export function useSignInTerms() {
  const [accepted, setAccepted] = useAtom(useCreateAtom(false))
  const [open, setOpen] = useAtom(useCreateAtom(false))
  const [dialogClosed, setDialogClosed] = useAtom(useCreateAtom(true))
  const [reminder, setReminder] = useAtom(useCreateAtom(false))
  const pending = useRef<(() => void) | null>(null)
  const checkbox = useRef<HTMLInputElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const shake = useRef<Animation | null>(null)
  const mobile = useIsMobile()

  useEffect(() => () => { pending.current = null; shake.current?.cancel() }, [])
  useEffect(() => {
    if (!accepted || open || !dialogClosed) return
    const continuation = pending.current
    pending.current = null
    continuation?.()
  }, [accepted, open, dialogClosed])

  const requestConsent = (continueSignIn: () => void) => {
    if (accepted) {
      if (!dialogClosed) pending.current = continueSignIn
      else {
        pending.current = null
        continueSignIn()
      }
      return
    }
    setReminder(true)
    shake.current?.cancel()
    shake.current = null
    if (mobile) {
      pending.current = continueSignIn
      setDialogClosed(false)
      setOpen(true)
      return
    }
    checkbox.current?.focus()
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shake.current = area.current?.animate?.([
        { transform: "translateX(0)" },
        { transform: "translateX(-6px)" },
        { transform: "translateX(6px)" },
        { transform: "translateX(-4px)" },
        { transform: "translateX(0)" },
      ], { duration: 280, easing: "ease-in-out" }) ?? null
    }
  }

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) pending.current = null
  }
  const confirm = () => {
    setAccepted(true)
    setReminder(false)
    setOpen(false)
  }

  return {
    requestConsent,
    control: <>
      <SignInTermsControl areaRef={area} checkboxRef={checkbox} accepted={accepted} reminder={reminder}
        onChange={event => { pending.current = null; setAccepted(event.target.checked); setReminder(false); shake.current?.cancel(); shake.current = null }} />
      <Dialog open={open} onOpenChange={changeOpen} onOpenChangeComplete={next => setDialogClosed(!next)}>
        <DialogContent showCloseButton={false} finalFocus={!accepted} className="w-[calc(100%-2rem)] max-w-sm">
          <DialogHeader>
            <DialogTitle>Agree to continue</DialogTitle>
            <DialogDescription><PolicyLinks /></DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row">
            <Button type="button" variant="outline" className="h-11 flex-1" data-testid="sign-in-terms-cancel" onClick={() => changeOpen(false)}>Cancel</Button>
            <Button type="button" className="h-11 flex-1" data-testid="sign-in-terms-confirm" onClick={confirm}>Agree</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>,
  }
}
