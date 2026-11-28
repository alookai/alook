import assert from "node:assert/strict";
import { test } from "vitest";
import { alookUserId } from "./plugin.mjs";
import { allowContentEmbedding, allowShellEmbedding, embedOrigins, handlePageHostRequest, pageSessionCookie, adaptSessionResponse } from "./host.mjs";

const id = "art_1234567890abcdef";
const app = "http://localhost:8795";
const parent = "http://localhost:3000";
const serviceKey = "only-a-test-key-with-at-least-32-bytes";
function fixture() {
  const users = new Map();
  const artifacts = new Map();
  const calls = [];
  const site = {
    config: { appOrigin: app, contentOrigin: "https://{id}.alook.page" },
    build: {
      shellHtml: '<!doctype html><head><link rel="stylesheet" href="/_open-artifact/shell/assets/shell-abc123.css"><script type="module" src="/_open-artifact/shell/assets/shell-abc123.js"></script></head>',
    },
    access: { invalidate: (artifactId) => { calls.push(["invalidate", artifactId]); } },
    fetch: async () => new Response("upstream", { headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'; script-src 'self'; frame-ancestors 'none'", "x-frame-options": "DENY" } }),
    ready: async () => ({
      getUser: async (key) => users.get(key),
      createUser: async (user) => { users.set(user.id, user); calls.push(["user", user]); return user; },
      updateUser: async (key, patch) => { const next = { ...users.get(key), ...patch }; users.set(key, next); return next; },
      getArtifact: async (key) => artifacts.get(key),
      trashArtifact: async (key) => { calls.push(["trash", key]); artifacts.get(key).trashedAt = "now"; },
      createArtifact: async (artifact) => { const stored = { ...artifact, trashedAt: null }; artifacts.set(artifact.id, stored); return stored; },
    }),
    services: () => ({ importArchive: async () => { calls.push(["import"]); return { type: "docs", title: "A document" }; } }),
    typeInfo: () => ({ title: "Document" }),
    removeArtifact: async () => { calls.push(["remove"]); },
  };
  const env = {
    ALOOK_EMBED_ORIGINS: JSON.stringify([parent]), ALOOK_WEB_ORIGIN: parent, ALOOK_PAGE_SERVICE_KEY: serviceKey,
    ALOOK_WEB: { fetch: async (req) => {
      calls.push(["exchange", req]);
      assert.equal(req.headers.get("authorization"), `Bearer ${serviceKey}`);
      return Response.json({ subject: "reader", name: "A person", pageId: "page", artifactId: id, sourceMessageId: "entry-a" });
    } },
  };
  const deps = { site, startSession: async (user) => { calls.push(["session", user.id]); return "oa_session=opaque; HttpOnly; Path=/; SameSite=Lax"; } };
  return { site, env, deps, calls, users, artifacts, run: (req) => handlePageHostRequest(req, env, {}, deps) };
}

test("embedding permits exact origins and retains the upstream script/content policy", () => {
  assert.deepEqual(embedOrigins(JSON.stringify([parent, parent])), [parent]);
  for (const value of ["[]", '"https://alook.invalid"', '["https://*.example.invalid"]', '["https://alook.invalid/path"]', '["http://public.invalid"]']) assert.throws(() => embedOrigins(value));
  const source = new Response("shell", { headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'; script-src 'sha256-abc'; frame-src https://content.invalid; frame-ancestors 'none'", "x-frame-options": "DENY" } });
  const result = allowShellEmbedding(source, [parent]);
  assert.equal(result.headers.get("x-frame-options"), null);
  assert.match(result.headers.get("content-security-policy"), /script-src 'sha256-abc'/);
  assert.match(result.headers.get("content-security-policy"), /frame-src https:\/\/content.invalid/);
  assert.match(result.headers.get("content-security-policy"), /frame-ancestors http:\/\/localhost:3000/);
});

test("only the app's exact successful Shell path becomes frameable", async () => {
  const f = fixture();
  assert.equal((await f.run(new Request(`${app}/a/${id}`))).headers.get("x-frame-options"), null);
  assert.equal((await f.run(new Request(`${app}/auth/sign-in`))).headers.get("x-frame-options"), "DENY");
  assert.equal((await f.run(new Request(`${app}/a/${id}/extra`))).headers.get("x-frame-options"), "DENY");
  assert.equal((await f.run(new Request(`http://content.localhost:8795/a/${id}`))).headers.get("x-frame-options"), "DENY");
});

test("the bootstrap removes its fragment before exchanging the ticket, preconnects content, preloads shell assets, and never places the ticket in a redirect query", async () => {
  const f = fixture();
  const response = await f.run(new Request(`${app}/alook/open/${id}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /frame-ancestors http:\/\/localhost:3000/);
  assert.match(csp, /script-src 'nonce-[^']+' 'self'/);
  assert.match(csp, /style-src 'self'/);
  const html = await response.text();
  assert.match(html, /<link rel="preconnect" href="https:\/\/art-1234567890abcdef\.alook\.page">/);
  assert.match(html, /<link rel="preload" as="style" href="\/_open-artifact\/shell\/assets\/shell-abc123\.css">/);
  assert.match(html, /<link rel="modulepreload" href="\/_open-artifact\/shell\/assets\/shell-abc123\.js" crossorigin>/);
  assert.match(html, /history.replaceState/);
  assert.match(html, /fetch\('\/alook\/session'/);
  assert.doesNotMatch(html, /\?ticket=/);
});

test("session bootstrap rejects other origins and creates only a member for a verified matching Page", async () => {
  const f = fixture();
  const req = (origin, artifactId = id) => new Request(`${app}/alook/session`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ ticket: "a".repeat(43), artifactId }),
  });
  const forbidden = await f.run(req("https://evil.invalid"));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get("server-timing"), null);
  assert.equal(f.calls.length, 0);
  const response = await f.run(req(app));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.deepEqual(f.calls.find(([kind]) => kind === "user")[1], { id: alookUserId("reader"), name: "A person", siteRole: "member" });
  assert.deepEqual(f.calls.find(([kind]) => kind === "session"), ["session", alookUserId("reader")]);
  f.env.ALOOK_WEB.fetch = async () => new Response(null, { status: 404 });
  assert.equal((await f.run(req(app))).status, 404);
  f.env.ALOOK_WEB.fetch = async () => Response.json({ subject: "reader", name: "A person", artifactId: "art_foreign12345" });
  assert.equal((await f.run(req(app))).status, 403);
  assert.equal(f.calls.filter(([kind]) => kind === "session").length, 1);
});

test("session timings attribute a delayed exchange, overlap catalog readiness, and never expose identity or change cookie and source", async () => {
  const f = fixture();
  const exchange = f.env.ALOOK_WEB.fetch;
  const ready = f.site.ready;
  let exchangeActive = false;
  let catalogActive = false;
  let overlapped = false;
  f.env.ALOOK_WEB.fetch = async (request) => {
    exchangeActive = true;
    if (catalogActive) overlapped = true;
    try {
      await new Promise(resolve => setTimeout(resolve, 15));
      return await exchange(request);
    } finally {
      exchangeActive = false;
    }
  };
  f.site.ready = async () => {
    catalogActive = true;
    if (exchangeActive) overlapped = true;
    try {
      await new Promise(resolve => setTimeout(resolve, 8));
      return await ready();
    } finally {
      catalogActive = false;
    }
  };
  const ticket = "a".repeat(43);
  const response = await f.run(new Request(`${app}/alook/session`, {
    method: "POST", headers: { "content-type": "application/json", origin: app }, body: JSON.stringify({ ticket, artifactId: id }),
  }));
  assert.equal(response.status, 200);
  assert.equal(overlapped, true);
  assert.deepEqual(await response.json(), { ok: true, sourceMessageId: "entry-a" });
  assert.equal(response.headers.get("set-cookie"), "oa_session=opaque; HttpOnly; Path=/; SameSite=Lax");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const header = response.headers.get("server-timing");
  const timings = new Map(header.split(", ").map(value => {
    const match = /^([a-z_]+);dur=(\d+(?:\.\d+)?)$/.exec(value);
    assert.ok(match, value);
    return [match[1], Number(match[2])];
  }));
  assert.deepEqual(new Set(timings.keys()), new Set(["alook_exchange", "oa_catalog", "oa_user", "oa_session", "alook_session"]));
  assert.equal(timings.size, 5);
  assert.ok(timings.get("alook_exchange") >= 5);
  assert.ok(timings.get("alook_session") >= timings.get("alook_exchange"));
  for (const value of [ticket, serviceKey, id, "reader", "A person", "entry-a", "opaque"]) assert.equal(header.includes(value), false);
});

test("session failures report the failed backend phase without creating a session", async () => {
  const f = fixture();
  f.site.ready = async () => { throw new Error("catalog unavailable"); };
  const response = await f.run(new Request(`${app}/alook/session`, {
    method: "POST", headers: { "content-type": "application/json", origin: app }, body: JSON.stringify({ ticket: "a".repeat(43), artifactId: id }),
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Page host unavailable" });
  const names = new Set(response.headers.get("server-timing").split(", ").map(value => value.split(";")[0]));
  assert.deepEqual(names, new Set(["alook_exchange", "oa_catalog", "alook_session"]));
  assert.equal(f.calls.some(([kind]) => kind === "session" || kind === "user"), false);
});

test("rejected viewer tickets fail fast without waiting for a stalled catalog", async () => {
  const f = fixture();
  let releaseCatalog;
  f.env.ALOOK_WEB.fetch = async () => new Response(null, { status: 404 });
  f.site.ready = () => new Promise((_resolve, reject) => { releaseCatalog = () => reject(new Error("late catalog error")); });
  const result = await Promise.race([
    f.run(new Request(`${app}/alook/session`, {
      method: "POST", headers: { "content-type": "application/json", origin: app }, body: JSON.stringify({ ticket: "a".repeat(43), artifactId: id }),
    })),
    new Promise((_, reject) => setTimeout(() => reject(new Error("404 waited on stalled catalog")), 200)),
  ]);
  assert.equal(result.status, 404);
  assert.equal(f.calls.some(([kind]) => kind === "session" || kind === "user"), false);
  const names = new Set(result.headers.get("server-timing").split(", ").map(value => value.split(";")[0]));
  assert.deepEqual(names, new Set(["alook_exchange", "alook_session"]));
  // Late catalog rejection after fast-fail must not surface as an unhandled rejection.
  releaseCatalog();
  await new Promise(resolve => setTimeout(resolve, 10));
});

test("publish requires the service credential and never replaces an existing Page", async () => {
  const f = fixture();
  const req = (key) => new Request(`${app}/alook/import/${id}`, { method: "POST", body: "archive", headers: { authorization: `Bearer ${key}`, "content-type": "application/zip", "x-alook-subject": "bot" } });
  assert.equal((await f.run(req("wrong"))).status, 401);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.run(req(serviceKey))).status, 201);
  assert.equal((await f.run(req(serviceKey))).status, 200);
  assert.equal(f.calls.filter(([kind]) => kind === "import").length, 1);
  const foreign = { ...f.artifacts.get(id), ownerUser: alookUserId("another-bot") };
  f.artifacts.set(id, foreign);
  assert.equal((await f.run(req(serviceKey))).status, 409);
});

test("publish refuses oversized archives before allocating a room", async () => {
  const f = fixture();
  const response = await f.run(new Request(`${app}/alook/import/${id}`, {
    method: "POST", body: "archive", headers: { authorization: `Bearer ${serviceKey}`, "content-type": "application/zip", "x-alook-subject": "bot", "content-length": String(16 * 1024 * 1024 + 1) },
  }));
  assert.equal(response.status, 413);
  assert.equal(f.calls.filter(([kind]) => kind === "import").length, 0);
});

test("Shell Ask trusts only the authenticated account and reports ordinary-message failure", async () => {
  const f = fixture();
  f.deps.authenticate = async () => ({ principal: { kind: "user", id: alookUserId("reader") } });
  let sent;
  f.env.ALOOK_WEB.fetch = async (request) => { sent = await request.json(); return new Response(null, { status: 201 }); };
  const req = (origin = app) => new Request(`${app}/api/open-artifact.artifacts.ask`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ id, text: "Fix this", subject: "forged" }) });
  assert.equal((await f.run(req("https://evil.invalid"))).status, 403);
  assert.equal(sent, undefined);
  assert.equal((await f.run(req())).status, 200);
  assert.deepEqual(sent, { subject: "reader", artifactId: id, text: "Fix this" });
  f.env.ALOOK_WEB.fetch = async () => new Response(null, { status: 403 });
  assert.equal((await f.run(req())).status, 403);
  f.deps.authenticate = async () => ({ principal: { kind: "anonymous" } });
  assert.equal((await f.run(req())).status, 401);
});

test("HTTPS embedding uses a secure partitioned cookie across Alook and Page sites", () => {
  const cookie = "oa_session=opaque; HttpOnly; Path=/; SameSite=Lax";
  assert.equal(pageSessionCookie(cookie, app), cookie);
  const result = pageSessionCookie(cookie, "https://alook.page");
  assert.match(result, /SameSite=None/);
  assert.match(result, /; Secure;/);
  assert.match(result, /; Partitioned$/);
  assert.match(result, /HttpOnly/);
  assert.doesNotMatch(result, /SameSite=Lax/);
});

test("session renewal and deletion keep the same partition while other cookies remain unchanged", () => {
  const headers = new Headers();
  headers.append("set-cookie", "__Host-oa_session=; Max-Age=0; HttpOnly; Secure; Path=/; SameSite=Lax");
  headers.append("set-cookie", "unrelated=value; Path=/; SameSite=Lax");
  const response = adaptSessionResponse(new Response(null, { headers }), "https://alook.page");
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /Max-Age=0/);
  assert.match(cookies[0], /SameSite=None; Partitioned/);
  assert.equal(cookies[1], "unrelated=value; Path=/; SameSite=Lax");
});

test("content-origin editor responses extend frame-ancestors only when already allowing the Shell origin", () => {
  const editor = new Response("<html></html>", {
    headers: { "content-security-policy": `frame-ancestors ${app}; object-src 'none'` },
  });
  const allowed = allowContentEmbedding(editor, app, [parent]);
  assert.equal(allowed.headers.get("content-security-policy"), `frame-ancestors ${app} ${parent}; object-src 'none'`);

  const denied = new Response("nope", {
    headers: { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" },
  });
  const untouched = allowContentEmbedding(denied, app, [parent]);
  assert.equal(untouched.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
});

test("whole-resource deletion requires the creator and retains a failed destruction for retry", async () => {
  const f = fixture();
  f.artifacts.set(id, { id, ownerUser: alookUserId("creator"), trashedAt: null });
  f.deps.purgeArtifact = async (_catalog, remove, input) => { await remove(input.id); f.artifacts.delete(input.id); };
  const req = (subject, credential = serviceKey) => new Request(`${app}/alook/resources/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${credential}`, "x-alook-subject": subject } });
  assert.equal((await f.run(req("creator", "wrong"))).status, 401);
  assert.equal((await f.run(req("reader"))).status, 404);
  const remove = f.site.removeArtifact;
  f.site.removeArtifact = async () => { throw new Error("storage unavailable"); };
  assert.equal((await f.run(req("creator"))).status, 503);
  assert.equal(f.artifacts.get(id).trashedAt, "now");
  f.site.removeArtifact = remove;
  assert.equal((await f.run(req("creator"))).status, 200);
  assert.equal(f.artifacts.has(id), false);
  assert.ok(f.calls.some(([kind, targetId]) => kind === "invalidate" && targetId === id));
  assert.equal((await f.run(req("creator"))).status, 200);
});
