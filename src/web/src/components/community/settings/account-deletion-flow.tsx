"use client"

import { useEffect, useRef, useState } from "react"
import { MailWarning, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { parseRetryAfterSeconds } from "@/lib/retry-after"
import { tid } from "@/lib/community/testids"

type Step = "notice" | "code"

type Props = {
  email: string
  onCancel: () => void
  onDeleted: () => Promise<void>
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string }
    switch (body.error) {
      case "INVALID_OTP": return "That code is incorrect. Try again."
      case "OTP_EXPIRED": return "That code expired. Send a new code."
      case "TOO_MANY_ATTEMPTS": return "Too many incorrect attempts. Send a new code."
      case "RATE_LIMITED": return "Too many requests. Try again when the timer ends."
      case "CODE_SEND_FAILED": return "We couldn’t send the code. Try again."
      case "ACCOUNT_DELETION_FAILED": return "Your account wasn’t deleted. Try again."
    }
  } catch {}
  return "Something went wrong. Try again."
}

export function AccountDeletionFlow({ email, onCancel, onDeleted }: Props) {
  const [step, setStep] = useState<Step>("notice")
  const [otp, setOtp] = useState("")
  const [sending, setSending] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [resendAfter, setResendAfter] = useState(0)
  const [error, setError] = useState("")
  const titleRef = useRef<HTMLHeadingElement>(null)
  const otpRef = useRef<HTMLInputElement>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [step])

  useEffect(() => {
    if (!error) return
    if (step === "code") otpRef.current?.focus()
    else errorRef.current?.focus()
  }, [error, step])

  useEffect(() => {
    if (resendAfter <= 0) return
    const timer = window.setTimeout(() => {
      setResendAfter((seconds) => Math.max(0, seconds - 1))
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [resendAfter])

  const sendCode = async () => {
    setSending(true)
    setError("")
    try {
      const response = await fetch("/api/community/users/me/account-deletion/code", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      if (!response.ok) {
        const retryAfter = response.status === 429
          ? parseRetryAfterSeconds(response.headers)
          : null
        if (retryAfter) setResendAfter(retryAfter)
        setError(await responseError(response))
        return
      }
      const body = await response.json() as { resend_after: number }
      setOtp("")
      setResendAfter(body.resend_after)
      setStep("code")
    } catch {
      setError("We couldn’t send the code. Check your connection and try again.")
    } finally {
      setSending(false)
    }
  }

  const deleteAccount = async () => {
    if (!/^\d{6}$/u.test(otp)) return
    setDeleting(true)
    setError("")
    try {
      const response = await fetch("/api/community/users/me/account-deletion", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otp }),
      })
      if (!response.ok) {
        setOtp("")
        setError(await responseError(response))
        setDeleting(false)
        return
      }
      await onDeleted()
    } catch {
      setOtp("")
      setError("Your account wasn’t deleted. Check your connection and try again.")
      setDeleting(false)
    }
  }

  return (
    <div
      className="mx-auto w-full max-w-md animate-in fade-in duration-150 motion-reduce:animate-none"
      data-testid={tid.accountDeletionFlow}
    >
      {step === "notice" ? (
        <section className="space-y-8">
          <div className="space-y-3">
            <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <Trash2 className="size-5" />
            </span>
            <h2 ref={titleRef} tabIndex={-1} className="text-xl font-medium tracking-tight outline-none">
              Delete your account?
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Your profile, messages, agents, and account data will be permanently removed.
            </p>
            <p className="text-sm font-medium">This can’t be undone.</p>
          </div>
          <div className="rounded-xl bg-muted/60 p-4">
            <div className="text-xs text-muted-foreground">Deletion code will be sent to</div>
            <div className="mt-1 break-all text-sm font-medium">{email}</div>
          </div>
          {error ? (
            <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-destructive outline-none">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" className="h-11 sm:h-9" onClick={onCancel} disabled={sending}>
              Cancel
            </Button>
            <Button className="h-11 sm:h-9" onClick={sendCode} disabled={sending || resendAfter > 0}>
              {sending
                ? "Sending code…"
                : resendAfter > 0
                  ? `Send deletion code in ${resendAfter}s`
                  : "Send deletion code"}
            </Button>
          </div>
        </section>
      ) : (
        <section className="space-y-8">
          <div className="space-y-3">
            <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <MailWarning className="size-5" />
            </span>
            <h2 ref={titleRef} tabIndex={-1} className="text-xl font-medium tracking-tight outline-none">
              Enter deletion code
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>.
            </p>
          </div>
          <InputOTP
            ref={otpRef}
            value={otp}
            onChange={(value) => { setOtp(value); setError("") }}
            maxLength={6}
            autoFocus
            disabled={deleting}
            aria-label="Deletion code"
            aria-invalid={!!error}
            containerClassName="justify-center sm:justify-start"
          >
            <InputOTPGroup>
              {Array.from({ length: 6 }, (_, index) => (
                <InputOTPSlot key={index} index={index} className="size-11 text-base" />
              ))}
            </InputOTPGroup>
          </InputOTP>
          {error ? (
            <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-destructive outline-none">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1 sm:flex-row">
              <Button
                variant="ghost"
                className="h-11 sm:h-9"
                onClick={() => { setError(""); setStep("notice") }}
                disabled={deleting}
              >
                Back
              </Button>
              <Button
                variant="ghost"
                className="h-11 sm:h-9"
                onClick={sendCode}
                disabled={deleting || sending || resendAfter > 0}
              >
                {sending
                  ? "Sending…"
                  : resendAfter > 0
                    ? `Resend code in ${resendAfter}s`
                    : "Resend code"}
              </Button>
            </div>
            <Button
              variant="destructive"
              className="h-11 sm:h-9"
              onClick={deleteAccount}
              disabled={deleting || otp.length !== 6}
              data-testid={tid.accountDeletionSubmit}
            >
              {deleting ? "Deleting account…" : "Delete account"}
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}
