"use client"

import { useSession } from "@/lib/auth-client"
import { LandingPage } from "./landing-page"

export function SessionLandingPage() {
  const session = useSession()
  return <LandingPage isLoggedIn={Boolean(session.data?.user)} />
}
