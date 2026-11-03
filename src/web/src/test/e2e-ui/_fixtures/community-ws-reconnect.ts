import type { Page } from "@playwright/test"

export const USER_WS_AUTH_CONSUMED_ATTRIBUTE = "data-e2e-user-ws-auth-consumed"

export async function installUserWsAuthConsumedBarrier(page: Page) {
  await page.addInitScript(({ attribute }) => {
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args)
        if (!new URL(this.url).pathname.endsWith("/user")) return
        this.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return
          try {
            const message = JSON.parse(event.data) as { type?: string }
            if (message.type !== "auth.ok") return
            setTimeout(() => {
              document.documentElement.setAttribute(attribute, "true")
            }, 0)
          } catch {}
        })
      }
    }
  }, { attribute: USER_WS_AUTH_CONSUMED_ATTRIBUTE })
}
