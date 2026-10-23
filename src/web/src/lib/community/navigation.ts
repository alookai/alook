"use client"

import { useContext, useMemo } from "react"
import { useRouter } from "next/navigation"
import { CommunityApplicationNavigation } from "@/contexts/community/application-navigation"
import { isCommunityApplicationPath } from "./application-route"

export function useCommunityHistoryRouter() {
  const router = useRouter()
  const application = useContext(CommunityApplicationNavigation)
  const local = useMemo(() => {
    const navigate = (method: "push" | "replace", href: string, options?: { scroll?: boolean }) => {
      const url = new URL(href, window.location.href)
      if (url.origin !== window.location.origin || !isCommunityApplicationPath(url.pathname)) {
        if (options) router[method](href, options)
        else router[method](href)
        return
      }
      window.history[method === "push" ? "pushState" : "replaceState"](null, "", `${url.pathname}${url.search}${url.hash}`)
    }
    return { ...router,
      push: (href: string, options?: { scroll?: boolean }) => navigate("push", href, options),
      replace: (href: string, options?: { scroll?: boolean }) => navigate("replace", href, options),
    }
  }, [router])
  return application ? local : router
}
