import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sourceMessageId } from "./source-context.mjs";
import { alookSubject, alookUserId, alookWebFetch } from "./plugin.mjs";

const artifactIdPattern = /^art_[a-z0-9]{10,40}$/;
const privateHeaders = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

export function embedOrigins(value) {
  let origins;
  try { origins = JSON.parse(value); } catch { throw new Error("Invalid Alook embedding origins"); }
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 16) throw new Error("Invalid Alook embedding origins");
  return [...new Set(origins.map((value) => {
    if (typeof value !== "string") throw new Error("Invalid Alook embedding origin");
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (value !== url.origin || url.username || url.password || url.hostname.includes("*") || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) throw new Error("Invalid Alook embedding origin");
    return url.origin;
  }))];
}

export function allowContentEmbedding(response, appOrigin, origins) {
  const csp = response.headers.get("content-security-policy");
  if (!csp) return response;
  let changed = false;
  const directives = csp.split(";").map((value) => value.trim()).filter(Boolean).map((directive) => {
    if (!/^frame-ancestors\s+/i.test(directive)) return directive;
    const tokens = directive.split(/\s+/).slice(1);
    if (!tokens.includes(appOrigin)) return directive;
    changed = true;
    return `frame-ancestors ${[...new Set([...tokens, ...origins])].join(" ")}`;
  });
  if (!changed) return response;
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", directives.join("; "));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function allowShellEmbedding(response, origins) {
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/html")) return response;
  const headers = new Headers(response.headers);
  const csp = headers.get("content-security-policy");
  if (!csp) throw new Error("Missing upstream Shell CSP");
  const directives = csp.split(";").map((value) => value.trim()).filter(Boolean).filter((value) => !/^frame-ancestors(?:\s|$)/i.test(value));
  directives.push(`frame-ancestors ${origins.join(" ")}`);
  headers.set("content-security-policy", directives.join("; "));
  headers.delete("x-frame-options");
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(value, status = 200, extra = {}) {
  return Response.json(value, { status, headers: { ...privateHeaders, ...extra } });
}

async function bodyBytes(request, limit) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw Object.assign(new Error("Page request too large"), { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error("Missing Page request body"), { status: 400 });
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw Object.assign(new Error("Page request too large"), { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function bodyJson(request, limit = 4096) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bodyBytes(request, limit))); }
  catch (error) { if (error.status) throw error; throw Object.assign(new Error("Invalid Page request"), { status: 400 }); }
}

function serviceAuthorized(request, secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) return false;
  const given = request.headers.get("authorization");
  if (!given?.startsWith("Bearer ")) return false;
  return timingSafeEqual(createHash("sha256").update(given.slice(7)).digest(), createHash("sha256").update(secret).digest());
}

function webFetch(env, path, body) {
  return alookWebFetch(env, new URL(path, env.ALOOK_WEB_ORIGIN), {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.ALOOK_PAGE_SERVICE_KEY}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
}

async function ensureUser(catalog, subject, name) {
  const id = alookUserId(subject);
  let user = await catalog.getUser(id);
  if (!user) {
    try { user = await catalog.createUser({ id, name, siteRole: "member" }); }
    catch (error) { user = await catalog.getUser(id); if (!user) throw error; }
  }
  if (user.disabledAt) throw Object.assign(new Error("Page account disabled"), { status: 403 });
  if (user.name !== name) user = await catalog.updateUser(id, { name });
  return user;
}

export function pageSessionCookie(cookie, origin) {
  if (new URL(origin).protocol !== "https:") return cookie;
  let value = cookie.replace(/;\s*SameSite=[^;]+/i, "; SameSite=None");
  if (!/;\s*SameSite=/i.test(value)) value += "; SameSite=None";
  if (!/;\s*Secure(?:;|$)/i.test(value)) value += "; Secure";
  return /;\s*Partitioned(?:;|$)/i.test(value) ? value : `${value}; Partitioned`;
}

export function adaptSessionResponse(response, origin) {
  if (new URL(origin).protocol !== "https:" || !response.headers.has("set-cookie")) return response;
  const headers = new Headers(response.headers);
  const cookies = headers.getSetCookie();
  headers.delete("set-cookie");
  for (const cookie of cookies) headers.append("set-cookie", /^(?:__Host-)?oa_session=/.test(cookie) ? pageSessionCookie(cookie, origin) : cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers, ...(response.webSocket ? { webSocket: response.webSocket } : {}) });
}

function contentPreconnectOrigin(contentOrigin, artifactId) {
  if (typeof contentOrigin !== "string" || !contentOrigin) return null;
  try {
    const url = new URL(contentOrigin.replace("{id}", artifactId.replace("_", "-")));
    if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function shellPreloadLinks(shellHtml) {
  if (typeof shellHtml !== "string" || !shellHtml) return "";
  const seen = new Set();
  const links = [];
  for (const match of shellHtml.matchAll(/(?:href|src)="(\/_open-artifact\/shell\/assets\/[A-Za-z0-9._-]+\.(?:css|js))"/g)) {
    const asset = match[1];
    if (seen.has(asset)) continue;
    seen.add(asset);
    if (asset.endsWith(".css")) links.push(`<link rel="preload" as="style" href="${asset}">`);
    else links.push(`<link rel="modulepreload" href="${asset}" crossorigin>`);
    if (links.length >= 8) break;
  }
  return links.join("");
}

function bootstrap(artifactId, origins, hints = {}) {
  const nonce = randomBytes(18).toString("base64url");
  const preconnect = contentPreconnectOrigin(hints.contentOrigin, artifactId);
  const preconnectTag = preconnect ? `<link rel="preconnect" href="${preconnect}">` : "";
  const preloadTags = shellPreloadLinks(hints.shellHtml);
  const script = `
const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket');
history.replaceState(null, '', location.pathname);
fetch('/alook/session', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket,artifactId:${JSON.stringify(artifactId)}})})
.then(async response => { if (!response.ok) throw new Error('This Page could not be opened. Return to Alook and try again.'); const identity = await response.json(); location.replace('/a/'+${JSON.stringify(artifactId)}+'?'+new URLSearchParams({sourceMessageId:identity.sourceMessageId})); })
.catch(error => { document.body.textContent=error.message; });`;
  const connectSrc = preconnect ? `'self' ${preconnect}` : "'self'";
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Alook Page</title>${preconnectTag}${preloadTags}<body>Opening Page…<script nonce="${nonce}">${script}</script>`;
  return new Response(html, { headers: { ...privateHeaders, "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}' 'self'; style-src 'self'; connect-src ${connectSrc}; base-uri 'none'; form-action 'none'; frame-ancestors ${origins.join(" ")}` } });
}

export async function handlePageHostRequest(request, env, ctx, { site, startSession, authenticate, actionsOfType, purgeArtifact }) {
  const url = new URL(request.url);
  if (!site.config || site.configError) return json({ error: "Page host unavailable" }, 503);
  let sessionTiming;
  try {
    const origins = embedOrigins(env.ALOOK_EMBED_ORIGINS);
    if (url.origin !== site.config.appOrigin) {
      return allowContentEmbedding(await site.fetch(request, ctx), site.config.appOrigin, origins);
    }
    const open = /^\/alook\/open\/(art_[a-z0-9]{10,40})$/.exec(url.pathname);
    if (open && request.method === "GET") return bootstrap(open[1], origins, { contentOrigin: site.config.contentOrigin, shellHtml: site.build?.shellHtml });
    if (url.pathname === "/api/open-artifact.embed" && request.method === "GET") return json({ hosts: origins });
    if (url.pathname === "/api/open-artifact.artifacts.ask" && request.method === "POST") {
      if (request.headers.get("origin") !== url.origin) return json({ error: "Forbidden" }, 403);
      const catalog = await site.ready();
      const auth = await authenticate(request, { catalog, config: site.config, now: () => new Date(), log: () => {}, ...(site.plugins ? { plugins: site.plugins } : {}) });
      const subject = alookSubject(auth.principal);
      if (!subject) return json({ error: "Unauthorized" }, 401);
      const body = await bodyJson(request, 64 * 1024);
      if (!artifactIdPattern.test(body.id) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 8000) return json({ error: "Invalid Page request" }, 400);
      const response = await webFetch(env, "/api/community/pages/artifact-comment", { subject, artifactId: body.id, text: body.text, sourceMessageId: sourceMessageId(request.headers.get("x-alook-source-message")) });
      await response.body?.cancel();
      return response.ok ? json({ via: "link", status: "delivered" }) : json({ error: "Page feedback could not be sent" }, response.status);
    }
    if (url.pathname === "/alook/session" && request.method === "POST") {
      if (request.headers.get("origin") !== url.origin || !request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "Forbidden" }, 403);
      const body = await bodyJson(request);
      if (typeof body.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.ticket) || !artifactIdPattern.test(body.artifactId)) return json({ error: "Invalid viewer ticket" }, 400);
      const started = performance.now();
      const timings = [];
      sessionTiming = () => [...timings, `alook_session;dur=${Math.max(0, performance.now() - started).toFixed(1)}`].join(", ");
      const measure = async (name, action) => {
        const phaseStarted = performance.now();
        try { return await action(); }
        finally { timings.push(`${name};dur=${Math.max(0, performance.now() - phaseStarted).toFixed(1)}`); }
      };
      const catalogPromise = measure("oa_catalog", () => site.ready());
      catalogPromise.catch(() => {});
      const response = await measure("alook_exchange", () => webFetch(env, "/api/community/pages/viewer-exchange", { ticket: body.ticket, origin: url.origin }));
      if (!response.ok) return json({ error: "Page access expired" }, response.status === 404 ? 404 : 503, { "server-timing": sessionTiming() });
      const identity = await bodyJson(response);
      if (typeof identity.subject !== "string" || !identity.subject || identity.subject.length > 128 || typeof identity.name !== "string" || identity.artifactId !== body.artifactId || !sourceMessageId(identity.sourceMessageId)) return json({ error: "Invalid Page identity" }, 403, { "server-timing": sessionTiming() });
      const catalog = await catalogPromise;
      const user = await measure("oa_user", () => ensureUser(catalog, identity.subject, identity.name.slice(0, 256)));
      const cookie = await measure("oa_session", () => startSession(user, request, { catalog, config: site.config, now: () => new Date(), log: () => {} }));
      return json({ ok: true, sourceMessageId: identity.sourceMessageId }, 200, { "set-cookie": pageSessionCookie(cookie, url.origin), "server-timing": sessionTiming() });
    }
    const deletion = /^\/alook\/resources\/(art_[a-z0-9]{10,40})$/.exec(url.pathname);
    if (deletion && request.method === "DELETE") {
      if (!serviceAuthorized(request, env.ALOOK_PAGE_SERVICE_KEY)) return json({ error: "Unauthorized" }, 401);
      const subject = request.headers.get("x-alook-subject");
      if (!subject) return json({ error: "Unauthorized" }, 401);
      const catalog = await site.ready();
      const artifact = await catalog.getArtifact(deletion[1]);
      if (artifact && artifact.ownerUser !== alookUserId(subject)) return json({ error: "Page not found" }, 404);
      if (artifact) {
        site.access?.invalidate?.(artifact.id);
        await catalog.trashArtifact(artifact.id);
        await purgeArtifact(catalog, id => site.removeArtifact(id), { id: artifact.id, actor: { kind: "user", id: alookUserId(subject) }, reason: "owner" });
      }
      return json({ deleted: true });
    }
    const operation = /^\/alook\/operate\/(art_[a-z0-9]{10,40})$/.exec(url.pathname);
    if (operation && request.method === "POST") {
      if (!serviceAuthorized(request, env.ALOOK_PAGE_SERVICE_KEY)) return json({ error: "Unauthorized" }, 401);
      const subject = request.headers.get("x-alook-subject");
      if (!subject) return json({ error: "Unauthorized" }, 401);
      const catalog = await site.ready();
      const artifact = await catalog.getArtifact(operation[1]);
      if (!artifact || artifact.trashedAt !== null) return json({ error: "Page not found" }, 404);
      const body = await bodyJson(request, 2 * 1024 * 1024);
      const access = await webFetch(env, "/api/community/pages/access", { subject, artifactId: artifact.id });
      if (!access.ok) { await access.body?.cancel(); return json({ error: "Page access unavailable" }, 503); }
      const { role } = await bodyJson(access);
      if (role !== "editor" && role !== "viewer") return json({ error: "Page not found" }, 404);
      if ((body.kind === "write" || body.kind === "action") && role !== "editor") return json({ error: "Page is read only" }, 403);
      const room = site.room(artifact.id);
      if (body.kind === "actions") return json({ actions: actionsOfType(artifact.type) });
      if (body.kind === "manifest") return json({ files: await room.manifest() });
      if (body.kind === "read" && typeof body.path === "string") {
        const file = await room.readFile(body.path);
        if (file && file.bytes.byteLength > 1024 * 1024) return json({ error: "Page file exceeds the 1 MiB read limit" }, 413);
        return file ? json({ content: Buffer.from(file.bytes).toString("base64"), etag: file.etag }) : json({ error: "File not found" }, 404);
      }
      if (body.kind === "write" && Array.isArray(body.writes) && body.writes.length > 0 && body.writes.length <= 16 && body.writes.every(write => Object.hasOwn(write, "if_match"))) {
        return json({ results: await room.writeFiles(body.writes, "agent") });
      }
      if (body.kind === "action" && typeof body.name === "string" && body.args && typeof body.args === "object") return json({ result: await room.action(body.name, body.args) });
      return json({ error: "Invalid Page operation" }, 400);
    }
    const upload = /^\/alook\/import\/(art_[a-z0-9]{10,40})$/.exec(url.pathname);
    if (upload && request.method === "POST") {
      if (!serviceAuthorized(request, env.ALOOK_PAGE_SERVICE_KEY)) return json({ error: "Unauthorized" }, 401);
      const subject = request.headers.get("x-alook-subject");
      if (!subject || !/^[A-Za-z0-9_-]{1,128}$/.test(subject)) return json({ error: "Invalid publisher" }, 400);
      const catalog = await site.ready();
      const owner = await ensureUser(catalog, subject, "Alook bot");
      const existing = await catalog.getArtifact(upload[1]);
      if (existing) return existing.ownerUser === owner.id && existing.trashedAt === null
        ? json({ artifactId: existing.id, type: existing.type, title: existing.title })
        : json({ error: "Page id conflict" }, 409);
      if (!request.headers.get("content-type")?.startsWith("application/zip")) return json({ error: "Expected a Page zip archive" }, 415);
      const bytes = await bodyBytes(request, 16 * 1024 * 1024);
      const imported = await site.services(ctx).importArchive(upload[1], bytes);
      if (!site.typeInfo(imported.type)) { await site.removeArtifact(upload[1]); return json({ error: "Unsupported Page type" }, 400); }
      let artifact;
      try {
        artifact = await catalog.createArtifact({ id: upload[1], type: imported.type, title: imported.title.trim().slice(0, 256) || "Untitled", ownerUser: owner.id, generalAccess: "restricted" });
      } catch (error) {
        artifact = await catalog.getArtifact(upload[1]);
        if (!artifact || artifact.ownerUser !== owner.id || artifact.trashedAt !== null) throw error;
      }
      return json({ artifactId: artifact.id, type: artifact.type, title: artifact.title }, 201);
    }
    const response = adaptSessionResponse(await site.fetch(request, ctx), url.origin);
    return /^\/a\/art_[a-z0-9]{10,40}$/.test(url.pathname) ? allowShellEmbedding(response, origins) : response;
  } catch (error) {
    const status = error && typeof error === "object" && Number.isInteger(error.status) ? error.status : 503;
    return json({ error: status === 413 ? "Page request too large" : "Page host unavailable" }, status, sessionTiming ? { "server-timing": sessionTiming() } : {});
  }
}
