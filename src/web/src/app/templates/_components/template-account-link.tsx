"use client"

import { useSession } from "@/lib/auth-client"
import { trackLandingCtaClicked } from "@/lib/analytics"
import { buttonVariants } from "@/components/ui/button"

export function TemplateAccountLink() {
  const session = useSession()
  const signedIn = Boolean(session.data?.user)
  return <a
    href={signedIn ? "/c/me" : "/sign-in"}
    onClick={() => trackLandingCtaClicked({ cta_name: signedIn ? "templates_open_app" : "templates_get_started" })}
    data-variant={signedIn ? "outline" : "default"}
    data-size="sm"
    className={buttonVariants({ variant: signedIn ? "outline" : "default", size: "sm", className: "h-auto gap-2 px-4 py-2 text-xs uppercase tracking-widest font-mono" })}
  >
    {signedIn ? "App" : "Get Started"}
  </a>
}
