"use client"

import { handleMessageExternalLinkClick } from "@/components/community/messages/message-external-link"

export function SignInTermsNotice() {
  const linkClass =
    "rounded-xs underline underline-offset-3 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"

  return (
    <p
      className="border-t border-border/60 pt-2 text-left text-xs leading-relaxed text-muted-foreground sm:pt-4 [@media(min-height:740px)]:pt-4"
      data-testid="sign-in-terms"
    >
      By continuing, you agree to our{" "}
      <a
        href="/terms"
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
        onClick={(event) => {
          void handleMessageExternalLinkClick(event, event.currentTarget.href)
        }}
      >
        Terms of Service
      </a>{" "}
      and{" "}
      <a
        href="/privacy"
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
        onClick={(event) => {
          void handleMessageExternalLinkClick(event, event.currentTarget.href)
        }}
      >
        Privacy Policy
      </a>{"."}
    </p>
  )
}
