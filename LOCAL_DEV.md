# Alook Local Dev

Use one browser entry for local development: `http://127.0.0.1:3003`.

## Setup

```bash
pnpm install --frozen-lockfile

cp src/web/.dev.vars.example src/web/.dev.vars
WEB_SECRET="$(openssl rand -base64 32)"
ENC_KEY="$(openssl rand -base64 32)"
node - <<'NODE' "$WEB_SECRET" "$ENC_KEY"
const fs = require("fs")
const [secret, enc] = process.argv.slice(2)
let text = fs.readFileSync("src/web/.dev.vars", "utf8")
for (const [key, value] of Object.entries({
  BETTER_AUTH_SECRET: secret,
  BETTER_AUTH_URL: "http://127.0.0.1:3003",
  ENCRYPTION_KEY: enc,
})) {
  text = text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`)
}
fs.writeFileSync("src/web/.dev.vars", text)

let email = fs.readFileSync("src/email-worker/.dev.vars.example", "utf8")
email = email.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${enc}`)
fs.writeFileSync("src/email-worker/.dev.vars", email)
NODE

pnpm db:migrate
pnpm db:seed:homepage-stubs
pnpm dev
```

`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` can stay empty; social login is unavailable until they are configured.

## Verification

Open `http://127.0.0.1:3003/sign-in`, enter `d1183898546@gmail.com`, and use the development email flow. In `next dev`, the app signs in or creates the user with the fixed internal dev password.

After login, `http://127.0.0.1:3003/workspaces?auto` creates a personal workspace from the email local-part when none exists. For `d1183898546@gmail.com`, the expected workspace slug is `d1183898546`.

`pnpm db:seed:homepage-stubs` adds 5 local-only agents, 2 local-only machines/runtimes, and one running stub task for Homepage/PET interaction testing. It is safe to rerun after the workspace exists.

Check:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3003/api/health
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3003/pet-preview
```

Both should return `200`.
