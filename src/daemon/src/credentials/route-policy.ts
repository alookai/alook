export const communityProxyRoutes = {
  channelMessages: (channelId: string) => `/api/community/channels/${channelId}/messages`,
  messageProperties: (messageId: string) => `/api/community/messages/${messageId}/properties`,
  inboxPull: "/api/community/users/me/inbox/pull",
  inboxAck: "/api/community/users/me/inbox/ack",
  inboxSnapshot: "/api/community/users/me/inbox/snapshot",
  profile: "/api/community/users/me/profile",
  avatar: "/api/community/users/me/avatar",
  marks: "/api/community/users/me/marks",
} as const;

export function resolveProxyCapability(method: string, pathname: string): string | undefined {
  if (pathname.startsWith("/api/community/machines")) return "read";
  if (pathname === "/api/community/bots" && method === "GET") return "read";
  if (pathname === "/api/community/bots/creation-requests" && method === "POST") return "send";
  if (
    ((method === "GET" || method === "PATCH") && pathname === communityProxyRoutes.profile)
    || (method === "POST" && pathname === communityProxyRoutes.avatar)
  ) return "profile";
  if (pathname.includes("/attachment")) return "attach";
  if (/\/friends(\/|$|\?)/.test(pathname)) return "friend";

  const isMessagesDoor = /\/channels\/[^/]+\/messages(\/|$|\?)/.test(pathname)
  if (isMessagesDoor) return method === "GET" ? "read" : "send";
  if (/\/messages\/[^/]+\/properties(\/|$|\?)/.test(pathname)) {
    return method === "GET" ? "read" : "send";
  }
  if (/\/messages\/[^/]+\/reactions\//.test(pathname)) return "send";
  if (method === "GET" && /\/users\/me\/marks(\/|$|\?)/.test(pathname)) return "read";
  if (method === "GET" && /\/messages\/[^/]+(\?|$)/.test(pathname)) return "read";

  if (pathname.includes("/history") || pathname.includes("/search") || pathname.includes("/inbox"))
    return "read";
  if (pathname.includes("/server") || pathname.includes("/channel")) return "server";
  return undefined;
}

export function resolveProxyAuditOperation(pathname: string, method?: string): string | null {

  const canonical = pathname.split("?")[0] ?? pathname;
  if (/^\/api\/community\/messages\/[^/]+\/properties$/.test(canonical)) {
    if (method === "GET") return "messagePropertyList";
    if (method === "PUT") return "messagePropertySet";
    if (method === "DELETE") return "messagePropertyRemove";
    return null;
  }
  if (/^\/api\/community\/messages\/[^/]+\/reactions\//.test(canonical)) return "reactAdd";
  if (method === "GET" && /^\/api\/community\/users\/me\/marks$/.test(canonical)) return "markList";
  if (/^\/api\/community\/channels\/[^/]+\/messages\/seq\//.test(canonical)) return "resolve";
  if (/^\/api\/community\/channels\/[^/]+\/messages(\/|$)/.test(canonical)) {
    return method === "GET" ? "read" : "send";
  }
  if (/^\/api\/community\/channels\/[^/]+\/members(\/|$)/.test(canonical)) return "channelMember";

  if (/^\/api\/community\/channels\/[^/]+\/attachments\/[^/]+/.test(canonical)) return "attachmentDownload";
  if (/^\/api\/community\/channels\/[^/]+\/attachments(\/|$)/.test(canonical)) return "attachmentUpload";

  if (/^\/api\/community\/messages\/[^/]+$/.test(canonical)) return "resolve";

  if (/^\/api\/community\/servers\/[^/]+\/members(\/|$)/.test(canonical)) return "listMembers";
  if (/^\/api\/community\/servers\/[^/]+\/channels(\/|$)/.test(canonical)) return "listChannels";
  if (/^\/api\/community\/servers\/channels(\/|$)/.test(canonical)) return "listChannels";

  if (/^\/api\/community\/friends\/(accepted|pending)(\/|$|\?)/.test(canonical)) return "listFriends";

  if (/^\/api\/community\/friends\/request(\/|$|\?)/.test(canonical)) return "friendRequest";

  if (/^\/api\/community\/users\/me\/inbox\/pull(\/|$|\?)/.test(canonical)) return "inboxPull";
  if (/^\/api\/community\/users\/me\/inbox\/snapshot(\/|$|\?)/.test(canonical)) return "inboxSnapshot";
  if (/^\/api\/community\/users\/me\/inbox\/ack(\/|$|\?)/.test(canonical)) return null; // ack writes no audit row here (re-homed to daemon reborn-ready signal)

  // A combined `setting profile` invocation is deliberately two canonical
  // mutations (avatar first, then bio). Keep them distinct in the authoritative
  // proxy audit so partial completion is visible instead of collapsing both
  // writes into one ambiguous shell-level event.
  if (method === "PATCH" && canonical === communityProxyRoutes.profile) return "profileBioUpdate";
  if (method === "POST" && canonical === communityProxyRoutes.avatar) return "profileAvatarUpdate";

  if (/^\/api\/community\/bots\/me\/nap(\/|$|\?)/.test(canonical)) return "nap";

  return null;
}

function propertyAuditMetadata(
  method: string,
  pathname: string,
  requestUrl: string,
): { propertyType: "emoji" | "tag" | "mark" } | undefined {
  if (
    (method !== "PUT" && method !== "DELETE")
    || !/^\/api\/community\/messages\/[^/]+\/properties$/.test(pathname)
  ) return undefined;
  const type = new URL(requestUrl, "http://placeholder").searchParams.get("type");
  return type === "emoji" || type === "tag" || type === "mark"
    ? { propertyType: type }
    : undefined;
}

export function resolveProxyRoute(pathname: string, method?: string, requestUrl = pathname) {
  return {
    capability: resolveProxyCapability(method ?? "", pathname),
    auditOperation: resolveProxyAuditOperation(pathname, method),
    propertyMetadata: propertyAuditMetadata(method ?? "", pathname, requestUrl),
    filterPiiSend: method === "POST" && /^\/api\/community\/channels\/[^/]+\/messages\/?$/.test(pathname),
    inboxObservation: method !== "POST" ? null
      : pathname === communityProxyRoutes.inboxPull ? "pull"
      : pathname === communityProxyRoutes.inboxAck ? "ack" : null,
    modelDiscovery: method === "POST" && /^\/api\/community\/machines\/[^/]+\/discover-models$/.test(pathname),
  };
}
