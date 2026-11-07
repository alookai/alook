"use client";

import { MockNetworkPill } from "./mock-network-pill";

export function MockNetworkBanner() {
  const enabled =
    process.env.NODE_ENV === "development" &&
    process.env.NEXT_PUBLIC_MOCK_NETWORK === "true";
  return enabled ? <MockNetworkPill /> : null;
}
