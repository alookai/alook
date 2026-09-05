"use client"

import { useEffect, useState } from "react"
import {
  readActiveCommunityReplicaSession,
  type CommunityReplicaLaunch,
} from "@/lib/community/replica/session"

export function useCommunityReplicaLaunch(pathname: string) {
  const [state, setState] = useState<{
    pathname: string
    loading: boolean
    launch: CommunityReplicaLaunch | null
  }>(() => ({ pathname, loading: true, launch: null }))

  useEffect(() => {
    let current = true
    void readActiveCommunityReplicaSession(pathname)
      .then((launch) => {
        if (current) setState({ pathname, loading: false, launch })
      })
      .catch(() => {
        if (current) setState({ pathname, loading: false, launch: null })
      })
    return () => {
      current = false
    }
  }, [pathname])

  if (state.pathname !== pathname) {
    return { loading: true, launch: null }
  }
  return { loading: state.loading, launch: state.launch }
}
