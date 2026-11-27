import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { writeArchive } = await import(pathToFileURL(resolve(root, "src/page-host/.cache/upstream/packages/server-sdk/src/zip.ts")).href);
const dir = await mkdtemp(join(tmpdir(), "alook-page-native-"));
const app = "http://pages.alook-native.localhost:49126";
const parent = "http://alook-native.localhost:49127";
const artifactId = "art_native1234567890";
const key = randomBytes(32).toString("base64url");
const tickets = new Set();
let allowed = true;
let checks = 0;
const feedback = [];
const ticket = () => { const value = randomBytes(32).toString("base64url"); tickets.add(value); return value; };
const assets = resolve(root, "src/page-host/dist/assets");
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png" };
const worker = resolve(root, "src/page-host/dist/site/worker.js");
let mf;
let server;
try {
  mf = new Miniflare(convertV4MiniflareOptions({
    name: "alook-page-native-test", host: "127.0.0.1", port: 49126,
    modulesRoot: dirname(worker),
    modules: [{ type: "ESModule", path: worker }, { type: "CompiledWasm", path: join(dirname(worker), "sheets.wasm") }],
    compatibilityDate: "2026-11-25", compatibilityFlags: ["nodejs_compat", "request_signal_passthrough"],
    bindings: {
      OA_APP_ORIGIN: app, OA_CONTENT_ORIGIN: "http://{id}.content.oa-native.localhost:49126", OA_SIGNING_KEYS: randomBytes(32).toString("base64url"),
      OA_OWNER_KEY: randomBytes(32).toString("base64url"), OA_SIGNUP: "owners-only", OA_PUBLIC_ACCESS: "false", OA_TYPES_PUBLISH: "off",
      ALOOK_WEB_ORIGIN: parent, ALOOK_EMBED_ORIGINS: JSON.stringify([parent]), ALOOK_PAGE_SERVICE_KEY: key,
      OA_PLUGINS: JSON.stringify([{ use: "alook", config: { origin: parent, secret: { env: "ALOOK_PAGE_SERVICE_KEY" } } }]),
    },
    d1Databases: { DB: "page-native-fixture" },
    durableObjects: { ROOMS: { className: "ArtifactObject", useSQLite: true }, HUB: { className: "SiteHubObject", useSQLite: true } },
    serviceBindings: {
      ALOOK_WEB: async (request) => {
        assert.equal(request.headers.get("authorization"), `Bearer ${key}`);
        const body = await request.json();
        if (new URL(request.url).pathname.endsWith("/viewer-exchange")) {
          if (!allowed || !tickets.delete(body.ticket) || body.origin !== app) return Response.json({ error: "denied" }, { status: 404 });
          return Response.json({ subject: "native-reader", name: "Native reader", pageId: "native-page", artifactId });
        }
        if (new URL(request.url).pathname.endsWith("/access")) {
          checks++;
          return Response.json({ role: allowed && body.subject === "native-reader" && body.artifactId === artifactId ? "editor" : null });
        }
        if (new URL(request.url).pathname.endsWith("/artifact-comment")) {
          if (!allowed || body.subject !== "native-reader" || body.artifactId !== artifactId) return Response.json({ error: "denied" }, { status: 404 });
          feedback.push(body);
          return Response.json({ message: { id: "ordinary-comment" } }, { status: 201 });
        }
        return new Response(null, { status: 404 });
      },
      ASSETS: async (request) => {
        const file = resolve(assets, `.${decodeURIComponent(new URL(request.url).pathname)}`);
        if (!file.startsWith(`${assets}/`)) return new Response(null, { status: 403 });
        try { return new Response(await readFile(file), { headers: { "content-type": types[extname(file)] ?? "application/octet-stream" } }); }
        catch { return new Response(null, { status: 404 }); }
      },
    },
  }));
  await mf.ready;
  const folder = join(dir, "native-page");
  await mkdir(folder);
  await writeFile(join(folder, ".artifact.json"), JSON.stringify({ type: "page", title: "Native Page", capabilities: { comments: {} } }));
  await writeFile(join(folder, "index.html"), '<!doctype html><html><head><title>Native Page</title></head><body><h1>Native Page</h1><p id="body">Real Worker and Durable Object storage.</p></body></html>');
  const zipPath = join(dir, "native-page.zip");
  await writeArchive(folder, zipPath);
  const published = await mf.dispatchFetch(`${app}/alook/import/${artifactId}`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "x-alook-subject": "native-bot", "content-type": "application/zip" }, body: await readFile(zipPath),
  });
  const publishedBody = await published.text();
  assert.equal(published.status, 201, publishedBody);
  console.log("Real Worker/D1/DO publication: PASS");
  const proof = ticket();
  const session = await mf.dispatchFetch(`${app}/alook/session`, {
    method: "POST", headers: { origin: app, "content-type": "application/json" }, body: JSON.stringify({ ticket: proof, artifactId }),
  });
  assert.equal(session.status, 200, await session.text());
  const cookie = session.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const shell = await mf.dispatchFetch(`${app}/a/${artifactId}`, { headers: { cookie } });
  assert.equal(shell.status, 200, await shell.clone().text());
  assert.equal(shell.headers.get("x-frame-options"), null);
  assert.ok(shell.headers.get("content-security-policy").includes(`frame-ancestors ${parent}`));
  const shellText = await shell.text();
  assert.match(shellText, /Native Page/);
  assert.ok(checks > 0);
  console.log("Real Worker cookie bootstrap, live permission check and Shell policy: PASS");
  const ask = await mf.dispatchFetch(`${app}/api/open-artifact.artifacts.ask`, {
    method: "POST", headers: { cookie, origin: app, "content-type": "application/json" }, body: JSON.stringify({ id: artifactId, text: "Change the heading", subject: "forged" }),
  });
  assert.equal(ask.status, 200, await ask.text());
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].subject, "native-reader");
  console.log("Real Shell Ask account-to-ordinary-message callback: PASS");
  const bootMatch = /window\.__OPEN_ARTIFACT_BOOT__\s*=\s*(.*?);<\/script>/.exec(shellText);
  assert.ok(bootMatch, "real Shell boot must be present");
  const page = JSON.parse(bootMatch[1]);
  const inner = new URL(page.page);
  const positioned = await mf.dispatchFetch(new URL("api/frame/cap", inner), {
    method: "POST", headers: { origin: inner.origin, "content-type": "application/json" },
    body: JSON.stringify({ cap: "comments", method: "sendToAgent", shell: true, args: { text: "Fix the first heading", label: "First heading", anchor: "h1" } }),
  });
  const positionedBody = await positioned.json();
  assert.equal(positioned.status, 200, JSON.stringify(positionedBody));
  assert.equal(positionedBody.error, undefined, JSON.stringify(positionedBody));
  assert.equal(feedback.at(-1).subject, "native-reader");
  assert.equal(feedback.at(-1).text, "Fix the first heading");
  assert.match(feedback.at(-1).location, /First heading/);
  console.log("Native positioned comment authenticated author through frame boundary: PASS");
  const operate = async (body) => {
    const response = await mf.dispatchFetch(`${app}/alook/operate/${artifactId}`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "x-alook-subject": "native-bot", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const actions = await operate({ kind: "actions" });
  assert.ok(actions.actions.some(action => action.name === "info"));
  const original = await operate({ kind: "read", path: "index.html" });
  const content = Buffer.from("<!doctype html><title>Native Page</title><h1>Native Page</h1><p>Updated without reimport.</p>").toString("base64");
  const written = await operate({ kind: "write", writes: [{ path: "index.html", content, if_match: original.etag }] });
  assert.equal(written.results[0].conflict, undefined);
  const conflict = await operate({ kind: "write", writes: [{ path: "index.html", content: original.content, if_match: original.etag }] });
  assert.equal(conflict.results[0].conflict, true);
  const retry = await mf.dispatchFetch(`${app}/alook/import/${artifactId}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "x-alook-subject": "native-bot", "content-type": "application/zip" }, body: await readFile(zipPath) });
  assert.equal(retry.status, 200);
  assert.equal((await operate({ kind: "read", path: "index.html" })).content, content);
  console.log("Native optimistic file write, stale conflict and non-overwriting publication retry: PASS");
  if (process.env.KEEP_NATIVE_PAGE_HOST !== "1") {
    const live = await mf.dispatchFetch(new URL("api/frame/events?c=nativeqa-client-0001", inner), { headers: { upgrade: "websocket", "sec-websocket-protocol": "baoyu-sse", origin: inner.origin } });
    assert.equal(live.status, 101);
    live.webSocket.accept();
    const bindings = await mf.getBindings();
    const connected = async () => (await (await bindings.ROOMS.get(bindings.ROOMS.idFromName(artifactId)).fetch(new Request(`http://room/connected?id=${artifactId}`, { headers: { "x-open-artifact-room-call": "1" } }))).json()).length;
    assert.equal(await connected(), 1);
    allowed = false;
    const until = Date.now() + 12_000;
    while (Date.now() < until && await connected() !== 0) await new Promise(done => setTimeout(done, 100));
    assert.equal(await connected(), 0);
    const refused = await mf.dispatchFetch(new URL("api/frame/session", inner), { headers: { origin: inner.origin } });
    assert.equal(refused.status, 403);
    live.webSocket.close();
    console.log("Native open WebSocket closed after source-access revocation; next read refused: PASS");
  }
  server = createServer(async (req, res) => {
    if (req.url === "/revoke") { allowed = false; res.end("revoked"); return; }
    if (req.url === "/stats") {
      const bindings = await mf.getBindings();
      const response = await bindings.ROOMS.get(bindings.ROOMS.idFromName(artifactId)).fetch(new Request(`http://room/connected?id=${artifactId}`, { headers: { "x-open-artifact-room-call": "1" } }));
      const connected = await response.json();
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ checks, allowed, connected: connected.length })); return;
    }
    const src = `${app}/alook/open/${artifactId}#ticket=${ticket()}`;
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Alook Page native integration</title><body><button onclick="fetch('/revoke')">Revoke fixture access</button><output id="state">Starting</output><iframe id="page" src="${src}" style="display:block;width:100%;height:850px;border:0"></iframe><script>const frame=document.getElementById('page'); addEventListener('message', e=>{if(e.origin!==${JSON.stringify(app)}||e.source!==frame.contentWindow||typeof e.data?.openArtifact!=='string')return; if(e.data?.openArtifact==='shell_hello'){frame.contentWindow.postMessage({openArtifact:'host_hello',protocol:1,caps:{toolbar:true,switcher:true},theme:{scheme:'light'}},e.origin)};document.getElementById('state').textContent=JSON.stringify(e.data)});</script>`);
  });
  await new Promise((done) => server.listen(49127, "127.0.0.1", done));
  console.log(`Native fixture ready at ${parent} (synthetic Alook authorization; no production data)`);
  if (process.env.KEEP_NATIVE_PAGE_HOST === "1") await new Promise((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); });
} finally {
  if (server) await new Promise((done) => server.close(done));
  await mf?.dispose();
  await rm(dir, { recursive: true, force: true });
}
