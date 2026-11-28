import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { here, pin, prepare, run, upstream } from "./prepare.mjs";
import { SHARED_EDITOR_BASE, shareEditorAssets } from "./editor-assets.mjs";

prepare();

function patch(file, edit, previousEdit) {
  const original = execFileSync("git", ["show", `${pin.revision}:${file}`], { cwd: upstream, encoding: "utf8" });
  const modified = edit(original);
  const path = resolve(upstream, file);
  const current = readFileSync(path, "utf8");
  if (current !== original && current !== modified && (!previousEdit || current !== previousEdit(original))) throw new Error(`Unrecognized upstream change in ${file}`);
  writeFileSync(path, modified);
}

function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error(`Pinned upstream seam changed: ${before}`);
  return text.replace(before, after);
}

for (const type of ["design", "design-system", "whiteboard", "data", "slides", "sheets", "docs", "motion"]) {
  patch(`packages/${type}-editor/vite.config.ts`, text => replaceOnce(text, "base: './',", `base: ${JSON.stringify(SHARED_EDITOR_BASE)},`));
}

patch("packages/host-cloudflare/src/plugins.ts", (text) => {
  text = replaceOnce(text, "export function startCloudflarePlugins(input: {", "export function startCloudflarePlugins(input: {\n  fetch?: typeof fetch;");
  text = replaceOnce(text, "services: pluginServices({", "services: pluginServices({\n      ...(input.fetch ? { fetch: input.fetch } : {}),");
  return `import type { ProductEnv } from './bindings.ts';\nimport { alookWebFetch } from ${JSON.stringify(resolve(here, "src/plugin.mjs"))};\n${text}\n
export function alookPluginFetch(env: ProductEnv): typeof fetch | undefined {
  if (!env.ALOOK_WEB && env.ALOOK_WEB_DEV_LOOPBACK !== '1') return undefined;
  return (input, init) => alookWebFetch(env, input, init);
}\n`;
});
patch("packages/host-cloudflare/src/site.ts", (text) => {
  text = `import { currentPageSource } from ${JSON.stringify(resolve(here, "src/source-context.mjs"))};\n${text}`;
  text = replaceOnce(text, "const token = await signPageToken(claims, config.signingKeys);", "const token = await signPageToken({ ...claims, sourceMessageId: currentPageSource() }, config.signingKeys);");
  text = replaceOnce(text, "import { startCloudflarePlugins, type PluginModules }", "import { alookPluginFetch, startCloudflarePlugins, type PluginModules }");
  return replaceOnce(text, "vars: stringVars(env),\n        modules:", "vars: stringVars(env),\n        fetch: alookPluginFetch(env),\n        modules:");
});
patch("packages/host-cloudflare/src/worker.ts", (text) => {
  text = `import { deliverPageRequest } from ${JSON.stringify(resolve(here, "src/comments.mjs"))};\n${text}`;
  text = replaceOnce(text, "    this.#host = host;", "    host.host.typeApi.wake = (id, body) => deliverPageRequest(env, id, body);\n    host.host.mayAskAgent = (_id, viewer) => viewer.role === 'editor';\n    host.host.dataRefresh = async (id, viewer, request) => { await deliverPageRequest(env, id, { requests: [{ id: crypto.randomUUID(), text: 'Refresh live data' + (request.queries ? ': ' + JSON.stringify(request.queries) : ''), from: { userId: viewer.id, sourceMessageId: viewer.sourceMessageId, name: viewer.name, role: viewer.role } }] }); return { online: false }; };\n    this.#host = host;");
  text = replaceOnce(text, "import { startCloudflarePlugins }", "import { alookPluginFetch, startCloudflarePlugins }");
  text = replaceOnce(text, "const ROOM_IMPORT_MAX_BYTES = 256 * 1024 * 1024;", "const ROOM_IMPORT_MAX_BYTES = 32 * 1024 * 1024;");
  text = replaceOnce(text, "const ROOM_IMPORT_MAX_FILES = 20_000;", "const ROOM_IMPORT_MAX_FILES = 2000;");
  text = replaceOnce(text, "        vars,\n        modules:", "        vars,\n        fetch: alookPluginFetch(env),\n        modules:");
  text = replaceOnce(text, "  async fetch(request: Request): Promise<Response> {\n    if (this.#error", `
  #alookAccessTimer: ReturnType<typeof setTimeout> | null = null;
  #alookWatchAccess(id: string | null): void {
    if (!id || !/^art_[a-z0-9]{10,40}$/.test(id) || this.#alookAccessTimer || !this.#room || !this.#host || this.#room.holders().length === 0) return;
    this.#alookAccessTimer = setTimeout(() => {
      const room = this.#room;
      const host = this.#host;
      if (!room || !host || room.holders().length === 0) { this.#alookAccessTimer = null; return; }
      void host.refresh(room, id).catch(() => { room.disconnectWhere(() => false); }).finally(() => { this.#alookAccessTimer = null; this.#alookWatchAccess(id); });
    }, 5000);
  }
  async fetch(request: Request): Promise<Response> {
    const alookId = request.headers.get('x-open-artifact-artifact') ?? (isRoomCall(request) ? new URL(request.url).searchParams.get('id') : null);
    if (this.#error`);
  text = replaceOnce(text, "      return handleRoomCall(this.#room, {", "      const response = await handleRoomCall(this.#room, {");
  text = replaceOnce(text, "      }, request);\n    }\n    return this.#room.fetch(request);", "      }, request);\n      this.#alookWatchAccess(alookId);\n      return response;\n    }\n    const response = await this.#room.fetch(request);\n    this.#alookWatchAccess(alookId);\n    return response;");
  return text;
});

patch("packages/host-cloudflare/src/room.ts", text => {
  const signature = "  async importArtifact(bytes: Uint8Array, options: { id: string; limits?: ImportLimits }): Promise<{ type: string; title: string }> {";
  return replaceOnce(text, signature, `
  private alookImport: Promise<{ type: string; title: string }> | null = null;
  async importArtifact(bytes: Uint8Array, options: { id: string; limits?: ImportLimits }): Promise<{ type: string; title: string }> {
    const prior = this.state.storage.sql.exec<{ value: string }>("SELECT value FROM oa_room_meta WHERE key = 'alook-import'").toArray()[0];
    if (prior) return JSON.parse(prior.value);
    return this.alookImport ??= this.alookImportNew(bytes, options).then(result => {
      this.state.storage.sql.exec("INSERT INTO oa_room_meta (key, value) VALUES ('alook-import', ?)", JSON.stringify(result));
      return result;
    }).finally(() => { this.alookImport = null; });
  }
  private async alookImportNew(bytes: Uint8Array, options: { id: string; limits?: ImportLimits }): Promise<{ type: string; title: string }> {`);
});
patch("packages/protocol/src/wake.ts", text => replaceOnce(text, "export interface WakeSender {", "export interface WakeSender {\n  userId?: string;\n  sourceMessageId?: string;"));
patch("packages/host-cloudflare/src/frames.ts", text => {
  text = replaceOnce(text, "export interface PlacedPage {", "export interface PlacedPage {\n  sourceMessageId?: string;");
  text = replaceOnce(text, "{ name: string; role: ArtifactRole } | undefined =>", "{ name: string; role: ArtifactRole; userId?: string; sourceMessageId?: string } | undefined =>");
  return replaceOnce(text, "{ name: by.name, role: placed?.role ?? 'editor' }", "{ name: by.name, role: placed?.role ?? 'editor', ...(placed?.ref.kind === 'user' ? { userId: placed.ref.id, sourceMessageId: placed.sourceMessageId } : {}) }");
});
function withPageSenderIdentity(text) {
  text = replaceOnce(text, "{ name: who.name, role: who.role });", "{ name: who.name, role: who.role, userId: who.id, sourceMessageId: who.sourceMessageId });");
  return replaceOnce(text, "{ name: who.name, client: author, id: who.id, role: who.role }", "{ name: who.name, client: author, id: who.id, role: who.role, sourceMessageId: who.sourceMessageId }");
}
patch("packages/type-server/src/server.ts", text => {
  text = withPageSenderIdentity(text);
  text = replaceOnce(text,
    "if (!isTypeName(type) || !hosted.has(type)) throw new HttpError(404, 'not_found', 'Not found.');",
    "if (type !== '_shared' && (!isTypeName(type) || !hosted.has(type))) throw new HttpError(404, 'not_found', 'Not found.');");
  return replaceOnce(text,
    "inside(resolve(editorDir(type), 'assets'), file)",
    "inside(resolve(options.assetsDir, 'editors/_shared/assets'), file)");
}, withPageSenderIdentity);
patch("packages/type-server/src/db-host.ts", text => {
  text = replaceOnce(text, "export interface DbGuest {", "export interface DbGuest {\n  sourceMessageId?: string;");
  return replaceOnce(text, "{ name: as.name, role: as.role } : undefined", "{ name: as.name, role: as.role, userId: as.id, sourceMessageId: as.sourceMessageId } : undefined");
});
patch("packages/runtime/src/capabilities.ts", text => replaceOnce(text, "export interface Viewer {", "export interface Viewer {\n  sourceMessageId?: string;"));
patch("packages/host/src/core/page-token.ts", text => {
  text = replaceOnce(text, "export interface PageTokenClaims {", "export interface PageTokenClaims {\n  sourceMessageId?: string;");
  text = replaceOnce(text, "a: claims.a, p: claims.p,", "sourceMessageId: claims.sourceMessageId, a: claims.a, p: claims.p,");
  text = replaceOnce(text, "  if (v.s !== undefined", "  if (v.sourceMessageId !== undefined && (typeof v.sourceMessageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.sourceMessageId))) return null;\n  if (v.s !== undefined");
  return replaceOnce(text, "return { a: v.a, p: v.p,", "return { sourceMessageId: v.sourceMessageId as string | undefined, a: v.a, p: v.p,");
});
patch("packages/host-cloudflare/src/room-host.ts", text => {
  text = replaceOnce(text,
`  const memo = new Map<string, { value: CachedAccess | null; until: number }>();
  const lookUp = async (id: string, ref: PrincipalRef): Promise<CachedAccess | null> => {
    const key = \`\${id}\\n\${refKey(ref)}\`;
    const at = now().getTime();
    const kept = memo.get(key);
    if (kept && kept.until > at) return kept.value;
    const value = await access.role(id, ref);
    memo.set(key, { value, until: at + maxAgeMs });
    if (memo.size > 5000) memo.delete(memo.keys().next().value!);
    return value;
  };
  const invalidate = (id: string): void => {
    access.invalidate(id);
    for (const key of [...memo.keys()]) if (key.startsWith(\`\${id}\\n\`)) memo.delete(key);
  };`,
`  let lookupGeneration = 0;
  const memo = new Map<string, { value: CachedAccess | null; until: number }>();
  const inflight = new Map<string, Promise<CachedAccess | null>>();
  const lookUp = async (id: string, ref: PrincipalRef): Promise<CachedAccess | null> => {
    const key = \`\${id}\\n\${refKey(ref)}\`;
    const at = now().getTime();
    const kept = memo.get(key);
    if (kept && kept.until > at) return kept.value;
    const pending = inflight.get(key);
    if (pending) return pending;
    const generation = lookupGeneration;
    const task = access.role(id, ref).then((value) => {
      if (generation === lookupGeneration && value !== null) {
        memo.set(key, { value, until: now().getTime() + maxAgeMs });
        if (memo.size > 5000) memo.delete(memo.keys().next().value!);
      }
      return value;
    }).finally(() => {
      if (inflight.get(key) === task) inflight.delete(key);
    });
    inflight.set(key, task);
    return task;
  };
  const invalidate = (id: string): void => {
    lookupGeneration++;
    access.invalidate(id);
    for (const key of [...memo.keys()]) if (key.startsWith(\`\${id}\\n\`)) memo.delete(key);
    for (const key of [...inflight.keys()]) if (key.startsWith(\`\${id}\\n\`)) inflight.delete(key);
  };`);
  text = replaceOnce(text, "return placed(found, ref, opaque);", "return { ...placed(found, ref, opaque), sourceMessageId: claims.sourceMessageId };");
  return replaceOnce(text, "return { title: artifact.title, type: artifact.type, viewer, principal: ref };", "return { title: artifact.title, type: artifact.type, viewer: { ...viewer, sourceMessageId: claims.sourceMessageId }, principal: ref };");
});
patch("packages/host/src/core/authz/access.ts", text => {
  text = replaceOnce(text,
    "  readonly #pluginAnswers = new Map<string, { role: ArtifactRole | null; until: number; generation: number; grantsVersion: number }>();",
    "  readonly #pluginAnswers = new Map<string, { role: ArtifactRole | null; until: number; generation: number; grantsVersion: number }>();\n  readonly #inflight = new Map<string, Promise<{ access: CachedAccess | null; failed?: string }>>();\n  #lookupGeneration = 0;");
  text = replaceOnce(text,
`  async role(artifactId: string, ref: PrincipalRef, options: { onCheckFailed?: (plugin: string) => void } = {}): Promise<CachedAccess | null> {
    const plugins = this.#plugins;`,
`  async role(artifactId: string, ref: PrincipalRef, options: { onCheckFailed?: (plugin: string) => void } = {}): Promise<CachedAccess | null> {
    const inflightKey = \`\${artifactId}\\n\${refKey(ref)}\`;
    let task = this.#inflight.get(inflightKey);
    if (!task) {
      const lookupGeneration = this.#lookupGeneration;
      task = this.#roleOnce(artifactId, ref, lookupGeneration).finally(() => {
        if (this.#inflight.get(inflightKey) === task) this.#inflight.delete(inflightKey);
      });
      this.#inflight.set(inflightKey, task);
    }
    const result = await task;
    if (result.failed) options.onCheckFailed?.(result.failed);
    return result.access;
  }

  async #roleOnce(artifactId: string, ref: PrincipalRef, lookupGeneration: number): Promise<{ access: CachedAccess | null; failed?: string }> {
    const plugins = this.#plugins;`);
  text = replaceOnce(text,
`    if (!artifact) {
      this.#entries.delete(artifactId);
      return null;
    }`,
`    if (!artifact) {
      this.#entries.delete(artifactId);
      return { access: null };
    }`);
  text = replaceOnce(text,
    "    if (kept && kept.until > now.getTime()) return kept.value ? { ...kept.value, artifact, epoch } : null;",
    "    if (kept && kept.until > now.getTime()) return { access: kept.value ? { ...kept.value, artifact, epoch } : null };");
  text = replaceOnce(text,
`    if (plugins && computed.principal && computed.artifact) {
      const decided = await this.#pluginRole(plugins, computed.principal, computed.artifact, computed.role ?? null, now.getTime(), generation);
      if (decided.failed) options.onCheckFailed?.(decided.failed);
      access = decided.role ? { role: decided.role, principal: computed.principal, artifact: computed.artifact } : null;
      if (decided.until < until) until = decided.until;
    }
    // Keep the answer only when it was worked out at the version this entry stands for.
    if (computed.artifact?.grantsVersion === entry.grantsVersion && this.#entries.get(artifactId) === entry) {
      entry.roles.set(key, { value: access, until });
    }
    return access ? { ...access, artifact, epoch } : null;`,
`    let failed: string | undefined;
    if (plugins && computed.principal && computed.artifact) {
      const decided = await this.#pluginRole(plugins, computed.principal, computed.artifact, computed.role ?? null, now.getTime(), generation, lookupGeneration);
      if (decided.failed) failed = decided.failed;
      access = decided.role ? { role: decided.role, principal: computed.principal, artifact: computed.artifact } : null;
      if (decided.until < until) until = decided.until;
    }
    // Keep the answer only when it was worked out at the version this entry stands for and no invalidation occurred.
    if (access !== null && lookupGeneration === this.#lookupGeneration && computed.artifact?.grantsVersion === entry.grantsVersion && this.#entries.get(artifactId) === entry) {
      entry.roles.set(key, { value: access, until });
    }
    return { access: access ? { ...access, artifact, epoch } : null, ...(failed ? { failed } : {}) };`);
  text = replaceOnce(text,
    "  async #pluginRole(plugins: Plugins, principal: Principal, artifact: ArtifactRow, hostRole: ArtifactRole | null, now: number, generation: number): Promise<{ role: ArtifactRole | null; until: number; failed?: string }> {",
    "  async #pluginRole(plugins: Plugins, principal: Principal, artifact: ArtifactRow, hostRole: ArtifactRole | null, now: number, generation: number, lookupGeneration = this.#lookupGeneration): Promise<{ role: ArtifactRole | null; until: number; failed?: string }> {");
  text = replaceOnce(text,
    "    if (seconds > 0) {\n      this.#pluginAnswers.delete(key);",
    "    if (seconds > 0 && answer.role !== null && lookupGeneration === this.#lookupGeneration) {\n      this.#pluginAnswers.delete(key);");
  return replaceOnce(text,
`  invalidate(artifactId?: string): void {
    if (artifactId === undefined) {
      this.#entries.clear();
      this.#pluginAnswers.clear();
    } else {
      this.#entries.delete(artifactId);
      for (const key of this.#pluginAnswers.keys()) if (key.startsWith(\`\${artifactId}\\n\`)) this.#pluginAnswers.delete(key);
    }
  }`,
`  invalidate(artifactId?: string): void {
    this.#lookupGeneration++;
    if (artifactId === undefined) {
      this.#entries.clear();
      this.#pluginAnswers.clear();
      this.#inflight.clear();
    } else {
      this.#entries.delete(artifactId);
      for (const key of this.#pluginAnswers.keys()) if (key.startsWith(\`\${artifactId}\\n\`)) this.#pluginAnswers.delete(key);
      for (const key of this.#inflight.keys()) if (key.startsWith(\`\${artifactId}\\n\`)) this.#inflight.delete(key);
    }
  }`);
});
patch("packages/host/src/core/app/views.ts", text => replaceOnce(text,
`export async function shellBoot(ctx: AppCtx, artifact: ArtifactRow, principal: Principal, role: ArtifactRole): Promise<ShellBoot> {
  const page = await ctx.pageFor(artifact, principal, role);
  const owner = await ctx.catalog.getUser(artifact.ownerUser);
  const type = ctx.typeInfo(artifact.type);
  return {
    id: artifact.id,
    url: artifactUrl(ctx, artifact.id),
    title: artifact.title,
    type: artifact.type,
    typeTitle: type?.title ?? artifact.type,
    root: '',
    page: page.url,
    pageUrl: page.pageUrl,
    pageKind: 'server',
    problem: type ? null : \`The \${artifact.type} type is not installed on this host.\`,
    empty: false,
    prompt: null,
    owner: null,
    agentName: await agentNameOf(ctx, artifact.ownerUser),
    userName: owner?.name ?? 'Owner',
    version: ctx.version,
    cloud: { ...cloudAccount(ctx, principal, shellPath(artifact.id)), role, settings: { ...artifact.settings }, agent: await cloudAgent(ctx, artifact.ownerUser) },
  };
}`,
`export async function shellBoot(ctx: AppCtx, artifact: ArtifactRow, principal: Principal, role: ArtifactRole): Promise<ShellBoot> {
  const [page, owner, agentName, agent] = await Promise.all([
    ctx.pageFor(artifact, principal, role),
    ctx.catalog.getUser(artifact.ownerUser),
    agentNameOf(ctx, artifact.ownerUser),
    cloudAgent(ctx, artifact.ownerUser),
  ]);
  const type = ctx.typeInfo(artifact.type);
  return {
    id: artifact.id,
    url: artifactUrl(ctx, artifact.id),
    title: artifact.title,
    type: artifact.type,
    typeTitle: type?.title ?? artifact.type,
    root: '',
    page: page.url,
    pageUrl: page.pageUrl,
    pageKind: 'server',
    problem: type ? null : \`The \${artifact.type} type is not installed on this host.\`,
    empty: false,
    prompt: null,
    owner: null,
    agentName,
    userName: owner?.name ?? 'Owner',
    version: ctx.version,
    cloud: { ...cloudAccount(ctx, principal, shellPath(artifact.id)), role, settings: { ...artifact.settings }, agent },
  };
}`));
patch("packages/shell/src/lib/api.ts", text => replaceOnce(text,
  "    let response: Response;",
  "    const source = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('sourceMessageId');\n    if (source) { const headers = new Headers(init.headers); headers.set('x-alook-source-message', source); init.headers = headers; }\n    let response: Response;"));
patch("packages/type-server/src/agent.ts", text => {
  text = replaceOnce(text, "  if (daemon && request.deliver === 'send') {", "  if (daemon) {");
  text = replaceOnce(text, "        text: request.text,", "        text: request.deliver === 'stage' ? 'Prepared request; wait for confirmation before acting.\\n\\n' + request.text : request.text,");
  text = replaceOnce(text, "return { status: 'delivered', ...('drafted' in result", "return { status: request.deliver === 'stage' ? 'staged' : 'delivered', ...('drafted' in result");
  return replaceOnce(text, "    // The daemon could not take it: keep it locally so `wait` still finds it.", "    return { status: 'failed', reason: 'Page feedback could not be sent. Retry from the Page.' };");
});

const entry = resolve(upstream, "packages/host-cloudflare/src/alook-worker.ts");
writeFileSync(entry, `
import BUILD from 'open-artifact:build';
import PLUGINS from 'open-artifact:plugins';
import { Site } from './site.ts';
import { authenticate, startSession, purgeArtifact } from '@open-artifact/host';
import { actionsOfType } from '@open-artifact/type-server';
import { frameActions } from '@open-artifact/server-sdk/frame/core';
import { withPageSource } from ${JSON.stringify(resolve(here, "src/source-context.mjs"))};
import { handlePageHostRequest } from ${JSON.stringify(resolve(here, "src/host.mjs"))};
export { ArtifactObject, SiteHubObject } from './worker.ts';
let site: Site | null = null;
export default {
  async fetch(request, env, ctx) {
    site ??= new Site(env, BUILD, { pluginModules: PLUGINS });
    return withPageSource(request, () => handlePageHostRequest(request, env, ctx, { site, startSession, authenticate, purgeArtifact, actionsOfType: type => type === 'page' ? Object.entries(frameActions).map(([name, action]) => ({ name, title: action.title, effect: action.effect, schema: action.schema })) : actionsOfType(type) }));
  },
  async scheduled(event, env, ctx) {
    site ??= new Site(env, BUILD, { pluginModules: PLUGINS });
    ctx.waitUntil(site.scheduled());
  },
};
`);

patch("deploy/cloudflare/build.mjs", (text) => {
  text = replaceOnce(text,
    "entryPoints: [join(pkg, entry)],",
    `entryPoints: [entry === 'worker.ts' ? ${JSON.stringify(entry)} : join(pkg, entry)],`);
  return replaceOnce(text,
    "    '/_open-artifact/frame/*',",
    [
      "    '/_open-artifact/editors/_shared/assets/*',",
      "    '  Cache-Control: public, max-age=31536000, immutable',",
      "    '/_open-artifact/editors/_shared/assets/chart-frame.txt',",
      "    '  ! Cache-Control',",
      "    '  Cache-Control: no-store',",
      "    '/_open-artifact/editors/_shared/assets/interactive-frame.txt',",
      "    '  ! Cache-Control',",
      "    '  Cache-Control: no-store',",
      "    '/_open-artifact/frame/*',",
    ].join("\n"));
});

const recipe = createHash("sha256").update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL("./editor-assets.mjs", import.meta.url))).digest("hex");
const receipt = resolve(upstream, ".alook-build-recipe");
const rebuild = !existsSync(receipt) || readFileSync(receipt, "utf8") !== recipe || !existsSync(resolve(upstream, "dist/server/editors"));
if (rebuild) {
  run("npm", ["run", "build"]);
}
console.log("shared editor assets:", await shareEditorAssets(resolve(upstream, "dist/server")));
if (rebuild) writeFileSync(receipt, recipe);
run("node", ["build.mjs"], resolve(upstream, "deploy/cloudflare"), {
  OA_PLUGINS_MODULE: resolve(here, "src/plugins.mjs"),
  OA_BUILD_DIST: resolve(here, "dist"),
});

copyFileSync(resolve(here, "LICENSE.open-artifact"), resolve(here, "dist/assets/LICENSE.open-artifact.txt"));
