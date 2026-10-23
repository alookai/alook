"use client"

import { useSession } from "@/lib/auth-client"
import { trackLandingCtaClicked } from "@/lib/analytics"

export function TemplateAccountLink() {
  const session = useSession()
  const signedIn = Boolean(session.data?.user)
  return <a
    href={signedIn ? "/c/me" : "/sign-in"}
    onClick={() => trackLandingCtaClicked({ cta_name: signedIn ? "templates_open_app" : "templates_get_started" })}
    className={signedIn
      ? "inline-flex items-center gap-2 px-4 py-2 text-xs uppercase tracking-widest font-mono border border-current transition-opacity hover:opacity-70"
      : "inline-flex items-center gap-2 px-4 py-2 text-xs uppercase tracking-widest font-mono bg-foreground text-background transition-opacity hover:opacity-70"}
  >
    {signedIn ? "App" : "Get Started"}
  </a>
}
