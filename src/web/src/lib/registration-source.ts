const REG_SOURCE_KEY = "alook_registration_source"

export function captureRegistrationSource() {
  if (typeof window === "undefined") return
  try {
    const params = new URLSearchParams(window.location.search)
    const utmSource = params.get("utm_source") || null
    const utmMedium = params.get("utm_medium") || null
    const utmCampaign = params.get("utm_campaign") || null
    const referrer = document.referrer || null
    if (utmSource || utmMedium || utmCampaign || referrer) {
      sessionStorage.setItem(
        REG_SOURCE_KEY,
        JSON.stringify({
          utm_source: utmSource,
          utm_medium: utmMedium,
          utm_campaign: utmCampaign,
          referrer,
        }),
      )
    }
  } catch {
    // sessionStorage unavailable (private browsing etc.)
  }
}

export function sendRegistrationSource() {
  if (typeof window === "undefined") return
  try {
    const raw = sessionStorage.getItem(REG_SOURCE_KEY)
    if (!raw) return
    sessionStorage.removeItem(REG_SOURCE_KEY)
    const data = JSON.parse(raw)
    fetch("/api/user/registration-source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // ignore
  }
}
