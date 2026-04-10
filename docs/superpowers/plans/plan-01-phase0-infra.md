# Phase 0 — Infrastructure Setup

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans

**Goal:** Scaffold the pnpm monorepo with Turborepo, create all 5 package directories with configs, wrangler.toml per Cloudflare service.

**Strategy:** Copy from `temp/spec-plans/` — these configs match the migration docs.

---

### Task 1: Root config files

**Files:**
- Create: `.gitignore`
- Create: `pnpm-workspace.yaml`
- Create: `package.json`
- Create: `turbo.json`
- Create: `vitest.config.ts`
- Create: `vitest.shared.ts`

- [ ] Copy root configs from spec-plans reference:

```bash
cp temp/spec-plans/pnpm-workspace.yaml .
cp temp/spec-plans/package.json .
cp temp/spec-plans/turbo.json .
cp temp/spec-plans/vitest.config.ts .
cp temp/spec-plans/vitest.shared.ts .
```

- [ ] Create `.gitignore` (merge main + spec-plans patterns):

```
node_modules/
dist/
.turbo/
.wrangler/
.env
.env.*
!.env.example
.next/
.open-next/
temp/
.DS_Store
plans/
```

- [ ] Commit

```bash
git add .gitignore pnpm-workspace.yaml package.json turbo.json vitest.config.ts vitest.shared.ts
git commit -m "chore: root monorepo configs"
```

---

### Task 2: Shared library scaffold

**Files:**
- Create: `src/shared/package.json`
- Create: `src/shared/tsconfig.json`
- Create: `src/shared/vitest.config.ts`
- Create: `src/shared/src/index.ts` (placeholder)

- [ ] Copy configs from spec-plans:

```bash
mkdir -p src/shared/src src/shared/test/utils
cp temp/spec-plans/src/shared/package.json src/shared/
cp temp/spec-plans/src/shared/tsconfig.json src/shared/
cp temp/spec-plans/src/shared/vitest.config.ts src/shared/
```

- [ ] Update `src/shared/package.json` to add `drizzle-orm` dependency per migration docs. The spec-plans version has no drizzle — edit the file:

Add to `"dependencies"`:
```json
"drizzle-orm": "^0.39.0",
"zod": "^3.24"
```

Note: spec-plans' shared package.json uses `"exports": { ".": { "import": "./dist/index.js" } }` with a build step. Migration docs say `"exports": { ".": "./src/index.ts" }` (no build). Update to match the migration docs: change exports to `{ ".": "./src/index.ts" }`, remove `"main"` and `"types"` fields, remove `"build"` and `"dev"` scripts (keep `"test"` and `"typecheck"`).

- [ ] Create placeholder `src/shared/src/index.ts`:

```typescript
// @alook/shared — populated in Phase 1
export {}
```

- [ ] Commit

```bash
git add src/shared/
git commit -m "chore: scaffold @alook/shared"
```

---

### Task 3: CLI scaffold

**Files:**
- Create: `src/cli/package.json`
- Create: `src/cli/tsconfig.json`
- Create: `src/cli/src/index.ts` (placeholder)

- [ ] Copy from spec-plans:

```bash
mkdir -p src/cli/src
cp temp/spec-plans/src/cli/package.json src/cli/
cp temp/spec-plans/src/cli/tsconfig.json src/cli/
```

- [ ] Create placeholder `src/cli/src/index.ts`:

```typescript
console.log("alook cli")
```

- [ ] Commit

```bash
git add src/cli/
git commit -m "chore: scaffold @alook/cli"
```

---

### Task 4: Web service scaffold

**Files:**
- Create: `src/web/package.json`
- Create: `src/web/tsconfig.json`
- Create: `src/web/next.config.ts`
- Create: `src/web/open-next.config.ts`
- Create: `src/web/postcss.config.mjs`
- Create: `src/web/components.json`
- Create: `src/web/wrangler.toml`
- Create: `src/web/vitest.config.ts`
- Create: `src/web/cloudflare-env.d.ts`
- Create: `src/web/src/env.d.ts`

- [ ] Copy config files from spec-plans:

```bash
mkdir -p src/web/src
cp temp/spec-plans/src/web/package.json src/web/
cp temp/spec-plans/src/web/tsconfig.json src/web/
cp temp/spec-plans/src/web/next.config.ts src/web/
cp temp/spec-plans/src/web/open-next.config.ts src/web/
cp temp/spec-plans/src/web/postcss.config.mjs src/web/
cp temp/spec-plans/src/web/components.json src/web/
cp temp/spec-plans/src/web/wrangler.toml src/web/
cp temp/spec-plans/src/web/vitest.config.ts src/web/
cp temp/spec-plans/src/web/cloudflare-env.d.ts src/web/
cp temp/spec-plans/src/web/src/env.d.ts src/web/src/
```

- [ ] Ensure `src/web/package.json` name is `@alook/web` and has `@alook/shared` as workspace dependency (it should from spec-plans, but verify).

- [ ] Commit

```bash
git add src/web/
git commit -m "chore: scaffold @alook/web"
```

---

### Task 5: Email worker scaffold

**Files:**
- Create: `src/email-worker/package.json`
- Create: `src/email-worker/tsconfig.json`
- Create: `src/email-worker/vitest.config.ts`
- Create: `src/email-worker/wrangler.toml`
- Create: `src/email-worker/src/index.ts` (placeholder)

- [ ] Copy from spec-plans:

```bash
mkdir -p src/email-worker/src
cp temp/spec-plans/src/email-worker/package.json src/email-worker/
cp temp/spec-plans/src/email-worker/tsconfig.json src/email-worker/
cp temp/spec-plans/src/email-worker/vitest.config.ts src/email-worker/
cp temp/spec-plans/src/email-worker/wrangler.toml src/email-worker/
```

- [ ] Create placeholder `src/email-worker/src/index.ts`:

```typescript
export default {
  async email() {},
  async fetch() { return new Response("email-worker") },
}
```

- [ ] Commit

```bash
git add src/email-worker/
git commit -m "chore: scaffold @alook/email-worker"
```

---

### Task 6: WS-DO scaffold

**Files:**
- Create: `src/ws-do/package.json`
- Create: `src/ws-do/tsconfig.json`
- Create: `src/ws-do/wrangler.toml`
- Create: `src/ws-do/src/index.ts` (placeholder)
- Create: `src/ws-do/src/env.d.ts`

- [ ] Copy from spec-plans:

```bash
mkdir -p src/ws-do/src
cp temp/spec-plans/src/ws-do/package.json src/ws-do/
cp temp/spec-plans/src/ws-do/tsconfig.json src/ws-do/
cp temp/spec-plans/src/ws-do/wrangler.toml src/ws-do/
cp temp/spec-plans/src/ws-do/src/env.d.ts src/ws-do/src/
```

- [ ] Create placeholder `src/ws-do/src/index.ts`:

```typescript
export default {
  async fetch() { return new Response("ws-do") },
}
export class WebSocketDurableObject {}
```

- [ ] Commit

```bash
git add src/ws-do/
git commit -m "chore: scaffold @alook/ws-do"
```

---

### Task 7: Install dependencies and verify

- [ ] Run `pnpm install` from project root
- [ ] Verify all packages resolve: `pnpm ls --depth 0`
- [ ] Commit lockfile

```bash
git add pnpm-lock.yaml
git commit -m "chore: install dependencies"
```

**Exit criteria:** `pnpm install` succeeds. All 5 packages exist with configs. Lockfile committed.
