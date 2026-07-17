import type { Metadata } from "next"
import { InviteAcceptClient } from "./invite-accept-client"

/**
 * /c/invite/:token
 *
 * Accept-invite page. Shows server name/icon and a "Join" button.
 * Sets Referrer-Policy: no-referrer to prevent token leakage.
 */
export const metadata: Metadata = {
  // Prevent token from being leaked via Referer header
  other: {
    "Referrer-Policy": "no-referrer",
  },
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  return <InviteAcceptClient token={token} />
}
