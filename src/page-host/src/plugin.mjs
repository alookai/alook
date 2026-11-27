import { Buffer } from "node:buffer";

export function alookUserId(subject) {
  return `alook_${Buffer.from(subject).toString("base64url")}`;
}

export function alookSubject(principal) {
  const user = principal.kind === "user" ? principal : principal.kind === "agent" ? principal.user : null;
  if (!user?.id?.startsWith("alook_")) return null;
  const encoded = user.id.slice(6);
  const subject = Buffer.from(encoded, "base64url").toString("utf8");
  return subject && subject.length <= 128 && alookUserId(subject) === user.id ? subject : null;
}

export default {
  id: "alook",
  apiVersion: 1,
  name: "Alook Page",
  version: "1.0.0",
  config: {
    origin: { type: "string", required: true },
    secret: { type: "secret", required: true },
  },
  validate(config) {
    if (typeof config.secret !== "string" || Buffer.byteLength(config.secret) < 32) return "The Page service key must contain at least 32 bytes.";
    try {
      const origin = new URL(config.origin);
      if (origin.origin !== config.origin || origin.username || origin.password || origin.hostname.includes("*") || !["https:", "http:"].includes(origin.protocol)) return "Alook must be an exact HTTP(S) origin.";
      if (origin.protocol === "http:" && origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1" && !origin.hostname.endsWith(".localhost")) return "Plain HTTP is permitted only on loopback.";
    } catch { return "Alook must be an exact HTTP(S) origin."; }
  },
  auth: {
    identity() { return { reject: "Open this Page from its Alook message." }; },
  },
  authz: {
    cacheSeconds: 0,
    async role({ principal, artifact }, ctx) {
      const subject = alookSubject(principal);
      if (!subject) return null;
      const response = await ctx.fetch(`${ctx.config.origin}/api/community/pages/access`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ctx.config.secret}` },
        body: JSON.stringify({ subject, artifactId: artifact.id }),
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) throw new Error("Alook permission check unavailable");
      const answer = await response.json();
      if (answer?.role === "editor" || answer?.role === "viewer" || answer?.role === null) return answer.role;
      throw new Error("Invalid Alook permission answer");
    },
  },
  guard({ action }) {
    if (["share.change", "artifact.create", "artifact.import", "link.connect", "link.publish", "mcp.connect", "type.publish"].includes(action)) return { deny: "Manage this Page through its Alook conversation." };
    if (action === "agent.ask") return { deny: "Send feedback from Alook to reply in the original conversation." };
  },
};
