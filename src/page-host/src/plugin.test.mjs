import assert from "node:assert/strict";
import { test } from "vitest";
import { alookSubject, alookUserId, alookWebFetch } from "./plugin.mjs";
import plugins from "./plugins.mjs";
const plugin = plugins.alook;

const secret = "only-a-test-service-key-with-32-bytes";
const ctx = (fetch) => ({ config: { secret, origin: "https://alook.example.invalid" }, fetch, signal: new AbortController().signal });
const input = (principal) => ({ principal, artifact: { id: "art_1234567890" }, role: "owner" });

test("Alook principal encoding is reversible and does not accept another provider's ids", () => {
  assert.equal(alookSubject({ kind: "user", id: alookUserId("person_1") }), "person_1");
  assert.equal(alookSubject({ kind: "user", id: "usr_foreign" }), null);
  assert.equal(alookSubject({ kind: "user", id: "alook_" }), null);
  assert.equal(alookSubject({ kind: "guest", id: alookUserId("person_1") }), null);
});

test("the plugin refuses unsafe origin/key settings and alternate login methods", () => {
  assert.equal(plugin.validate({ origin: "https://alook.example.invalid", secret }), undefined);
  for (const origin of ["https://alook.example.invalid/path", "http://public.example.invalid", "https://*.example.invalid", "javascript:1"]) {
    assert.equal(typeof plugin.validate({ origin, secret }), "string");
  }
  assert.equal(typeof plugin.validate({ origin: "https://alook.example.invalid", secret: "short" }), "string");
  assert.ok(plugin.auth.identity().reject);
});

test("anonymous, guest and foreign principals never fall back to public shares", async () => {
  const forbidden = () => { throw new Error("must not fetch"); };
  for (const principal of [{ kind: "anonymous" }, { kind: "guest", id: "guest" }, { kind: "user", id: "usr_other" }]) {
    assert.equal(await plugin.authz.role(input(principal), ctx(forbidden)), null);
  }
});

test("roles come only from live Alook checks with the real account and artifact", async () => {
  let calls = 0;
  const role = async (value) => plugin.authz.role(input({ kind: "user", id: alookUserId("reader") }), ctx(async (url, init) => {
    calls++;
    assert.equal(url, "https://alook.example.invalid/api/community/pages/access");
    assert.equal(init.headers.authorization, `Bearer ${secret}`);
    assert.deepEqual(JSON.parse(init.body), { subject: "reader", artifactId: "art_1234567890" });
    return Response.json({ role: value });
  }));
  assert.equal(await role("editor"), "editor");
  assert.equal(await role("viewer"), "viewer");
  assert.equal(await role(null), null);
  await assert.rejects(role("owner"), /Invalid Alook/);
  assert.equal(calls, 4);
  assert.equal(plugin.authz.cacheSeconds, 0);
});

test("failed permission checks do not grant the upstream owner or share role", async () => {
  const principal = { kind: "user", id: alookUserId("reader") };
  await assert.rejects(plugin.authz.role(input(principal), ctx(async () => new Response(null, { status: 503 }))), /unavailable/);
  await assert.rejects(plugin.authz.role(input(principal), ctx(async () => { throw new Error("offline"); })), /offline/);
});

test("sharing and parallel agent connections are refused while normal exports remain available", () => {
  for (const action of ["share.change", "artifact.create", "artifact.import", "link.connect", "mcp.connect", "type.publish", "agent.ask"]) {
    assert.ok(plugin.guard({ action }).deny);
  }
  assert.equal(plugin.guard({ action: "artifact.export" }), undefined);
});

test("alookWebFetch enforces exact origin and never bypasses service binding on non-loopback origins", () => {
  assert.throws(
    () => alookWebFetch({ ALOOK_WEB_ORIGIN: "https://alook.example.invalid", ALOOK_WEB_DEV_LOOPBACK: "1" }, "https://alook.example.invalid/api/community/pages/access"),
    /Alook service binding unavailable/,
  );
  assert.throws(
    () => alookWebFetch({ ALOOK_WEB_ORIGIN: "http://localhost:3000", ALOOK_WEB_DEV_LOOPBACK: "1" }, "http://evil.localhost:3000/api/community/pages/access"),
    /Untrusted Alook service origin/,
  );
});
