import type { Metadata } from "next"
import { SignupTracker } from "@/components/signup-tracker"
import { InviteAcceptClient } from "./invite-accept-client"

export const metadata: Metadata = {
  // Invite tokens must not leave the document through Referer.
  referrer: "no-referrer",
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  return <><SignupTracker /><InviteAcceptClient token={token} /></>
}
