# Phase 3 — Frontend (Pages + Components)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans

**Goal:** Copy frontend pages, components, contexts, and CSS from main. Adapt auth for Better Auth. Add WebSocket hooks from spec-plans.

**Strategy:** Bulk copy from `temp/main/`, then make targeted edits for auth changes. New auth pages from spec-plans.

**Depends on:** Phase 2a (web service API routes must exist)

---

### Task 1: Global CSS and public assets

**Files:**
- Create: `src/web/src/app/globals.css`
- Create: `src/web/public/` assets

- [ ] Copy from main:

```bash
mkdir -p src/web/src/app src/web/public
cp temp/main/src/web/app/globals.css src/web/src/app/
cp -r temp/main/src/web/public/* src/web/public/ 2>/dev/null || true
```

- [ ] Commit

```bash
git add src/web/src/app/globals.css src/web/public/
git commit -m "feat(web): global CSS and public assets"
```

---

### Task 2: UI components (copy as-is)

**Files:**
- Create: `src/web/src/components/ui/*.tsx` (all UI primitives)

- [ ] Copy all UI components from main:

```bash
mkdir -p src/web/src/components/ui
cp temp/main/src/web/components/ui/button.tsx src/web/src/components/ui/
cp temp/main/src/web/components/ui/input.tsx src/web/src/components/ui/
cp temp/main/src/web/components/ui/textarea.tsx src/web/src/components/ui/
cp temp/main/src/web/components/ui/label.tsx src/web/src/components/ui/
cp temp/main/src/web/components/ui/badge.tsx src/web/src/components/ui/
cp temp/main/src/web/components/ui/card.tsx src/web/src/components/ui/
cp temp/main/src/web/components/ui/dialog.tsx src/web/src/components/ui/
cp temp/main/src/web/components/ui/confirm-dialog.tsx src/web/src/components/ui/
cp temp/main/src/web/components/ui/select.tsx src/web/src/components/ui/
cp temp/main/src/web/components/ui/sheet.tsx src/web/src/components/ui/
cp temp/main/src/web/components/ui/scroll-area.tsx src/web/src/components/ui/
cp temp/main/src/web/components/ui/separator.tsx src/web/src/components/ui/
cp temp/main/src/web/components/ui/avatar.tsx src/web/src/components/ui/
```

Do NOT copy `input-otp.tsx` — OTP is no longer needed with Better Auth.

- [ ] Fix import paths: main uses `@/components/ui/...` and `@/lib/utils`. In the new structure, the `@/*` alias maps to `./src/*`, so paths like `@/components/ui/button` resolve to `src/web/src/components/ui/button`. This matches main's pattern — no changes needed.

- [ ] Commit

```bash
git add src/web/src/components/ui/
git commit -m "feat(web): UI component primitives from main"
```

---

### Task 3: Feature components

**Files:**
- Create: `src/web/src/components/theme-provider.tsx`
- Create: `src/web/src/components/toaster-provider.tsx`
- Create: `src/web/src/components/logo.tsx`
- Create: `src/web/src/components/theme-toggle.tsx`
- Create: `src/web/src/components/gradient-background.tsx`
- Create: `src/web/src/components/dashboard-navbar.tsx`
- Create: `src/web/src/components/agent-edit-form.tsx`
- Create: `src/web/src/components/runtime-select.tsx`
- Create: `src/web/src/components/app-sidebar.tsx`

- [ ] Copy from main:

```bash
cp temp/main/src/web/components/theme-provider.tsx src/web/src/components/
cp temp/main/src/web/components/toaster-provider.tsx src/web/src/components/
cp temp/main/src/web/components/logo.tsx src/web/src/components/
cp temp/main/src/web/components/theme-toggle.tsx src/web/src/components/
cp temp/main/src/web/components/gradient-background.tsx src/web/src/components/
cp temp/main/src/web/components/dashboard-navbar.tsx src/web/src/components/
cp temp/main/src/web/components/agent-edit-form.tsx src/web/src/components/
cp temp/main/src/web/components/runtime-select.tsx src/web/src/components/
cp temp/main/src/web/components/app-sidebar.tsx src/web/src/components/
```

- [ ] **Edit `app-sidebar.tsx`:** Replace the signOut logic. Main likely clears localStorage JWT. Replace with Better Auth signOut:

```typescript
import { signOut } from "@/lib/auth-client"
// In the sign-out handler:
await signOut()
```

- [ ] Commit

```bash
git add src/web/src/components/
git commit -m "feat(web): feature components from main (sidebar, agent form, etc.)"
```

---

### Task 4: Agent context provider

**Files:**
- Create: `src/web/src/contexts/agent-context.tsx`

- [ ] Copy from main:

```bash
mkdir -p src/web/src/contexts
cp temp/main/src/web/contexts/agent-context.tsx src/web/src/contexts/
```

- [ ] Adapt auth: main's context may use JWT token for API calls. With Better Auth, the session cookie is sent automatically — remove any manual Authorization header logic in `apiFetch` calls within this file.

- [ ] Commit

```bash
git add src/web/src/contexts/
git commit -m "feat(web): agent context provider from main"
```

---

### Task 5: Root layout and app layout

**Files:**
- Create: `src/web/src/app/layout.tsx`
- Create: `src/web/src/app/(app)/layout.tsx`

- [ ] Copy from main:

```bash
mkdir -p src/web/src/app/\(app\)
cp temp/main/src/web/app/layout.tsx src/web/src/app/
cp temp/main/src/web/app/\(app\)/layout.tsx src/web/src/app/\(app\)/
```

- [ ] **Edit root `layout.tsx`:** Check for any auth-related imports. Main may import ThemeProvider and fonts — these should work as-is. If it imports from `sonner` or `streamdown`, ensure those deps are in `src/web/package.json`. Check spec-plans' package.json for the correct dependency list.

- [ ] **Edit app `layout.tsx`:** Main's app layout likely has a JWT auth guard. Replace with Better Auth session check:

```typescript
import { getSession } from "@/lib/session"
import { redirect } from "next/navigation"

// In the layout component:
const session = await getSession()
if (!session) redirect("/sign-in")
```

- [ ] Commit

```bash
git add src/web/src/app/layout.tsx src/web/src/app/\(app\)/layout.tsx
git commit -m "feat(web): root and app layouts from main"
```

---

### Task 6: Auth pages (new for Better Auth)

**Files:**
- Create: `src/web/src/app/(auth)/sign-in/page.tsx`
- Create: `src/web/src/app/(auth)/sign-up/page.tsx`

- [ ] Copy from spec-plans (these are Better Auth pages):

```bash
mkdir -p src/web/src/app/\(auth\)/sign-in src/web/src/app/\(auth\)/sign-up
cp temp/spec-plans/src/web/src/app/\(auth\)/sign-in/page.tsx src/web/src/app/\(auth\)/sign-in/
cp temp/spec-plans/src/web/src/app/\(auth\)/sign-up/page.tsx src/web/src/app/\(auth\)/sign-up/
```

These pages use `signIn`, `signUp` from `@/lib/auth-client` (Better Auth client).

- [ ] Commit

```bash
git add src/web/src/app/\(auth\)/
git commit -m "feat(web): sign-in and sign-up pages (Better Auth)"
```

---

### Task 7: App pages from main

**Files:**
- Create: `src/web/src/app/page.tsx` (root redirect)
- Create: `src/web/src/app/(app)/home/page.tsx`
- Create: `src/web/src/app/(app)/agents/page.tsx`
- Create: `src/web/src/app/(app)/agents/[id]/page.tsx`
- Create: `src/web/src/app/(app)/agents/new/page.tsx`
- Create: `src/web/src/app/(app)/chat/[id]/page.tsx`
- Create: `src/web/src/app/(app)/runtimes/page.tsx`

- [ ] Copy from main:

```bash
cp temp/main/src/web/app/page.tsx src/web/src/app/

mkdir -p src/web/src/app/\(app\)/home
cp temp/main/src/web/app/\(app\)/home/page.tsx src/web/src/app/\(app\)/home/

mkdir -p src/web/src/app/\(app\)/agents/\[id\] src/web/src/app/\(app\)/agents/new
cp temp/main/src/web/app/\(app\)/agents/page.tsx src/web/src/app/\(app\)/agents/
cp temp/main/src/web/app/\(app\)/agents/\[id\]/page.tsx src/web/src/app/\(app\)/agents/\[id\]/
cp temp/main/src/web/app/\(app\)/agents/new/page.tsx src/web/src/app/\(app\)/agents/new/

mkdir -p src/web/src/app/\(app\)/chat/\[id\]
cp temp/main/src/web/app/\(app\)/chat/\[id\]/page.tsx src/web/src/app/\(app\)/chat/\[id\]/

mkdir -p src/web/src/app/\(app\)/runtimes
cp temp/main/src/web/app/\(app\)/runtimes/page.tsx src/web/src/app/\(app\)/runtimes/
```

- [ ] **Edit `page.tsx` (root):** Main's root page checks for JWT and redirects to `/home` or `/login`. Change `/login` to `/sign-in`. Use Better Auth session check:

```typescript
import { getSession } from "@/lib/session"
import { redirect } from "next/navigation"

export default async function Page() {
  const session = await getSession()
  if (session) redirect("/home")
  redirect("/sign-in")
}
```

- [ ] **Review all app pages** for JWT/token references and replace with Better Auth patterns. Common changes:
  - `localStorage.getItem("token")` → remove (session cookie is automatic)
  - `/login` references → `/sign-in`
  - `useSession()` from custom hook → `useSession()` from `@/lib/auth-client`

- [ ] Commit

```bash
git add src/web/src/app/
git commit -m "feat(web): app pages from main (home, agents, chat, runtimes)"
```

---

### Task 8: WebSocket hooks from spec-plans

**Files:**
- Create: `src/web/src/lib/use-ws.ts`
- Create: `src/web/src/lib/use-user-ws.ts`
- Create: `src/web/src/hooks/use-mobile.ts` (if exists)

- [ ] Copy WebSocket hooks from spec-plans:

```bash
cp temp/spec-plans/src/web/src/lib/use-ws.ts src/web/src/lib/
cp temp/spec-plans/src/web/src/lib/use-user-ws.ts src/web/src/lib/
mkdir -p src/web/src/hooks
cp temp/spec-plans/src/web/src/hooks/use-mobile.ts src/web/src/hooks/ 2>/dev/null || true
```

These hooks connect to WS-DO for real-time notifications. They work as-is.

- [ ] Commit

```bash
git add src/web/src/lib/use-ws.ts src/web/src/lib/use-user-ws.ts src/web/src/hooks/
git commit -m "feat(web): WebSocket hooks from spec-plans"
```

---

### Task 9: Verify dependencies and fix missing packages

- [ ] Check `src/web/package.json` has all dependencies needed by the frontend:
  - `sonner` (toasts) — add if missing
  - `streamdown` (markdown rendering in chat) — add if missing
  - `next-themes` (theme provider) — add if missing
  - `@base-ui/react` (UI primitives) — check if still used
  - `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css` — shadcn deps

Compare `temp/main/src/web/package.json` dependencies with `src/web/package.json`. Add any missing frontend dependencies.

- [ ] Run `pnpm install` from project root to update lockfile
- [ ] Commit

```bash
git add src/web/package.json pnpm-lock.yaml
git commit -m "chore(web): add missing frontend dependencies"
```

**Exit criteria:** Frontend pages render. Auth flow uses Better Auth. WebSocket hooks available. All components resolve their imports.
