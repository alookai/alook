const DISCORD_INVITE_URL = "https://discord.gg/24PHyEHU3M"

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
