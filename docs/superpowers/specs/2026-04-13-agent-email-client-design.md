# Agent Email Client Redesign

## Overview

Transform the agent detail page from a sidebar-based navigation (Chat / Email) into an email-client-first experience. Chat moves to the top bar; the default view becomes a full email client with Inbox, Sent, and Compose.

## Features / Showcase

1. **No more sidebar** -- the agent detail page drops the left sidebar. "Chat" becomes an icon button in the top bar alongside Edit and Remove.
2. **Email client as default view** -- landing on `/w/:slug/agents/:id` takes you to the email interface instead of chat.
3. **Inbox** -- existing inbound emails, same data as today, displayed in a left-panel list with a right-panel detail view.
4. **Sent** -- outbound emails sent by the agent, same list/detail layout as Inbox.
5. **Compose** -- rich text compose view with TipTap editor. Fields: From (agent handle, read-only), To, Subject, Body (HTML).
6. **Outbound sending** -- agent sends email via Cloudflare Email Routing `SendEmail` binding.
7. **Delete** -- the only email action for now, available in the detail view toolbar.

## Design Overview

### Layout Change

**Before:**
```
[ runtime-dot  agent-name          Edit  Remove ]
[ Sidebar: Chat | Email ] [ Content area       ]
```

**After:**
```
[ runtime-dot  agent-name    Chat  Edit  Remove ]
[ Inbox | Sent | Compose   ] [ Content area     ]
```

- The `AgentDetailSidebar` component is removed.
- A `Chat` icon button (MessageSquare) is added to the top bar, between the agent name and Edit. It navigates to `/w/:slug/agents/:id/chat`.
- The default redirect changes from `/chat` to `/email`.
- The email page itself contains folder tabs (Inbox / Sent) at the top of the left panel, plus a Compose button.

### Email Page Structure

The email page becomes a self-contained email client:

```
+-------------------------------------------+
| [Inbox] [Sent]              [+ Compose]   |
+----------------+--------------------------+
| Email list     | Email detail / Compose   |
| (left panel)   | (right panel)            |
|                |                          |
| - sender/recip | Subject                  |
| - subject      | From / To / Date         |
| - time         | [Delete]                 |
| - badge        |                          |
|                | Body                     |
|                |                          |
+----------------+--------------------------+
```

**Folder tabs:**
- **Inbox** (default): shows inbound emails (`direction = "inbound"`), ordered by `created_at` desc.
- **Sent**: shows outbound emails (`direction = "outbound"`), ordered by `created_at` desc.

**Compose view:**
- Replaces the right panel (detail area) when active.
- Fields:
  - **From**: read-only, shows `{agent.email_handle}@alook.ai`
  - **To**: text input, email address
  - **Subject**: text input
  - **Body**: TipTap rich text editor (starter kit + placeholder extension)
- Buttons: **Send** (primary), **Discard** (ghost)
- On send success: switch to Sent folder, show the sent email at top.
- On send failure: toast error, keep compose open.

**Email detail view:**
- Same as current layout (subject, from/to/date, body) but with a small toolbar row at the top containing a Delete button (trash icon).
- Inbound emails show: From, To, Received date, body.
- Sent emails show: To, From, Sent date, body.

### Data Model Changes

**Extend `emails` table with two new columns:**

```sql
ALTER TABLE emails ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound';
ALTER TABLE emails ADD COLUMN html_body TEXT NOT NULL DEFAULT '';
```

- `direction`: `"inbound"` or `"outbound"`. Existing rows are all `"inbound"`. New outbound emails get `"outbound"`.
- `html_body`: stores the HTML body for outbound emails composed with the rich text editor. For inbound emails, body is still read from R2 (raw RFC822). For outbound emails, the raw RFC822 is also stored in R2, but `html_body` provides quick access without R2 fetch.

**No changes to `agentWhitelist`** -- whitelist only governs inbound email triggering, not outbound.

**Schema update in `src/shared/src/db/schema.ts`:**
```ts
export const emails = sqliteTable("emails", {
  // ... existing columns ...
  direction: text("direction").notNull().default("inbound"),
  htmlBody: text("html_body").notNull().default(""),
});
```

**Type update in `src/shared/src/types.ts`:**
```ts
export interface Email {
  // ... existing fields ...
  direction: "inbound" | "outbound";
  html_body: string;
}
```

### API Changes

**New: `POST /api/email/send`**
- Auth required + workspace member check.
- Request body: `{ agentId, to, subject, htmlBody }`
- Validates agent belongs to workspace and has an `emailHandle`.
- Calls the email worker's new `/send` endpoint via service binding.
- Email worker constructs the RFC822 message, stores raw in R2, sends via `SendEmail` binding.
- Creates email record with `direction: "outbound"`.
- Returns the created email.

**New: `DELETE /api/email/[id]`**
- Auth required + workspace member check.
- Validates email belongs to an agent in the workspace.
- Deletes the email record (R2 object can be cleaned up lazily or left).

**Modified: `GET /api/email`**
- Add optional `direction` query param to filter by `"inbound"` or `"outbound"`.
- Default: returns all (backwards compatible).

### Outbound Email Sending

Outbound email is handled directly by the **web worker** (not the email worker). The email worker stays focused on inbound reception.

The `POST /api/email/send` route does everything:
1. Validates input and agent ownership.
2. Constructs RFC822 raw content from the compose fields.
3. Stores raw email in R2 (`EMAIL_BUCKET`).
4. Creates the `emails` DB record with `direction: "outbound"` and `htmlBody`.
5. Sends via the `SendEmail` binding using Cloudflare's builder syntax.

**New bindings in web worker `wrangler.toml`:**
```toml
[[send_email]]
name = "SEND_EMAIL"
```

The web worker already has `DB` and `EMAIL_BUCKET` (R2) bindings. It only needs the new `SEND_EMAIL` binding. This keeps the architecture simple -- one worker per concern (email worker = inbound, web worker = outbound + everything else).

### New Dependencies

| Package | Purpose |
|---------|---------|
| `@tiptap/react` | React integration for TipTap editor |
| `@tiptap/starter-kit` | Bold, italic, lists, headings, code, blockquote |
| `@tiptap/extension-placeholder` | Placeholder text in empty editor |

Added to `src/web/package.json` only.

### Migration

A Drizzle migration adds the two new columns:
```sql
ALTER TABLE emails ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound';
ALTER TABLE emails ADD COLUMN html_body TEXT NOT NULL DEFAULT '';
```

Existing emails are all inbound, so the default values handle them correctly.

## Component Breakdown

### Modified Components

1. **`src/web/src/app/(app)/w/[slug]/agents/[id]/layout.tsx`**
   - Add Chat icon button to top bar (between agent name and Edit).
   - Remove `AgentDetailSidebar` from content area.
   - Children render full-width without sidebar.

2. **`src/web/src/app/(app)/w/[slug]/agents/[id]/page.tsx`**
   - Change redirect from `/chat` to `/email`.

3. **`src/web/src/app/(app)/w/[slug]/agents/[id]/email/page.tsx`**
   - Major rewrite: add folder tabs (Inbox/Sent), compose button, compose view.
   - Filter emails by `direction` based on active tab.
   - Add delete action to detail view.

4. **`src/shared/src/db/schema.ts`** -- add `direction` and `htmlBody` columns.

5. **`src/shared/src/types.ts`** -- add fields to `Email` interface.

6. **`src/shared/src/db/queries/email.ts`** -- add `getEmailsByDirection()`, `deleteEmail()`.

7. **`src/web/src/lib/api.ts`** -- add `sendEmail()`, `deleteEmail()` functions.

8. **`src/web/src/lib/api/responses.ts`** -- map new fields in `emailToResponse()`.

### New Components

9. **`src/web/src/components/email-compose.tsx`** -- Compose form with TipTap editor.

### Removed Components

10. **`src/web/src/components/agent-detail-sidebar.tsx`** -- deleted entirely.

### Backend Routes

11. **`src/web/src/app/api/email/send/route.ts`** -- new POST endpoint for outbound.
12. **`src/web/src/app/api/email/[id]/route.ts`** -- add DELETE handler.

### Config

13. **`src/web/wrangler.toml`** -- add `send_email` binding for outbound.
14. **`src/web/cloudflare-env.d.ts`** -- add `SEND_EMAIL: SendEmail` to `Env` interface (or regenerate with `cf-typegen`).

## Error Handling

- **Send fails**: toast "Failed to send email", keep compose state intact so user can retry.
- **Delete fails**: toast "Failed to delete email".
- **No email handle**: if agent has no `emailHandle` configured, compose button is disabled with tooltip "Configure an email handle in agent settings to send emails".
- **Invalid recipient**: basic email format validation client-side before send.

## Testing Strategy

- Unit tests for new query functions (`getEmailsByDirection`, `deleteEmail`).
- API route tests for `POST /api/email/send` and `DELETE /api/email/[id]`.
- Existing email tests continue to pass (inbound flow unchanged).
