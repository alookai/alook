"use client"

import { createContext, useCallback, useContext, useEffect, useMemo } from "react"
import { usePathname } from "next/navigation"
import {
  contextMenuDisposition,
  isNativeContextMenuPolicyExcludedPath,
  type ContextMenuDisposition,
} from "@/lib/authenticated-context-menu-policy"

export type AuthenticatedContextMenuPolicy = {
  disposition(event: MouseEvent): ContextMenuDisposition
}

const AuthenticatedContextMenuPolicyContext = createContext<AuthenticatedContextMenuPolicy | null>(null)

export function createAuthenticatedContextMenuHandler(
  disposition: AuthenticatedContextMenuPolicy["disposition"],
) {
  return (event: MouseEvent) => {
    if (disposition(event) === "product") event.preventDefault()
  }
}

export function useAuthenticatedContextMenuPolicy() {
  return useContext(AuthenticatedContextMenuPolicyContext)
}

export function AuthenticatedContextMenuBoundary({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const enabled = !isNativeContextMenuPolicyExcludedPath(pathname)
  const disposition = useCallback((event: MouseEvent) => contextMenuDisposition({
    event,
    selection: window.getSelection(),
    ownerDocument: document,
  }), [])
  const policy = useMemo<AuthenticatedContextMenuPolicy | null>(
    () => enabled ? { disposition } : null,
    [disposition, enabled],
  )

  useEffect(() => {
    if (!policy || typeof document === "undefined") return
    const handler = createAuthenticatedContextMenuHandler(policy.disposition)
    document.addEventListener("contextmenu", handler, { capture: true })
    return () => document.removeEventListener("contextmenu", handler, { capture: true })
  }, [policy])

  return (
    <AuthenticatedContextMenuPolicyContext.Provider value={policy}>
      {children}
    </AuthenticatedContextMenuPolicyContext.Provider>
  )
}
