import { DISCORD_INVITE_URL } from "./discord-invite"

const discordRedirect = {
  fetch(): Response {
    return new Response(null, {
      status: 302,
      headers: {
        Location: DISCORD_INVITE_URL,
        "Cache-Control": "no-store",
      },
    })
  },
}

export default discordRedirect
