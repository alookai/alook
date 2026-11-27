import assert from "node:assert/strict";
import { test } from "vitest";
import { deliverPageRequest } from "./comments.mjs";
import { alookUserId } from "./plugin.mjs";

const artifactId = "art_1234567890abcdef";
function fixture(status = 201) {
  const calls = [];
  return { calls, env: { ALOOK_WEB_ORIGIN: "https://alook.invalid", ALOOK_PAGE_SERVICE_KEY: "test-secret", ALOOK_WEB: { fetch: async (request) => { calls.push(await request.json()); return new Response(null, { status }); } } } };
}
test("native requests and positioned comments use the stamped account, not a display name", async () => {
  const f = fixture();
  const from = { userId: alookUserId("reader"), name: "Another person's name", role: "editor" };
  const thread = { id: "thread", from, file: "document", where: "Section 2", messages: [{ text: "Old context" }, { text: "Fix this", at: "2026-11-27T05:00:00Z" }] };
  assert.deepEqual(await deliverPageRequest(f.env, artifactId, { threads: [thread] }), { status: "delivered", via: "live" });
  await deliverPageRequest(f.env, artifactId, { threads: [thread] });
  assert.equal(f.calls[0].subject, "reader");
  assert.equal(f.calls[0].text, "Fix this");
  assert.equal(f.calls[0].location, "document · Section 2 · Comment thread");
  assert.equal(f.calls[0].nonce, f.calls[1].nonce);
  await deliverPageRequest(f.env, artifactId, { requests: [{ id: "request", from, text: "Update the title" }] });
  assert.notEqual(f.calls[0].nonce, f.calls[2].nonce);
});
test("unstamped and foreign authors fail without guessing their account", async () => {
  const f = fixture();
  for (const from of [undefined, { name: "reader" }, { userId: "usr_elsewhere", name: "reader" }]) {
    await assert.rejects(deliverPageRequest(f.env, artifactId, { requests: [{ id: "request", from, text: "Hello" }] }), /authenticated author/);
  }
  assert.equal(f.calls.length, 0);
});
test("failed ordinary message delivery stays failed", async () => {
  const f = fixture(403);
  await assert.rejects(deliverPageRequest(f.env, artifactId, { requests: [{ id: "request", from: { userId: alookUserId("reader") }, text: "Hello" }] }), /could not be sent/);
});
