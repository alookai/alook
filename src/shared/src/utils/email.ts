const DOMAIN = `@${process.env.ALOOK_DOMAIN || "alook.ai"}`

export function toAlookAddress(h: string) { return `${h}${DOMAIN}` }
