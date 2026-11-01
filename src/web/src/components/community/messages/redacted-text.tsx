import type { ReactNode } from "react"

export const REDACTED = /\[REDACTED(?:_[A-Z0-9]+)*\]/g

export function RedactedBadge({ children }: { children?: ReactNode }) {
  return <span data-redacted role="img" aria-label="redacted" className="inline-block whitespace-nowrap rounded-sm bg-muted px-1 align-baseline font-sans text-xs font-medium leading-normal text-muted-foreground after:content-['redacted']"><span aria-hidden className="sr-only">{children}</span></span>
}

export function parts(text: string): string[] {
  return text.split(new RegExp(`(${REDACTED.source})`, "g"))
}

export function RedactedText({ text }: { text: string }) {
  return <>{parts(text).map((value, index) => index % 2 ? <RedactedBadge key={index}>{value}</RedactedBadge> : value)}</>
}
