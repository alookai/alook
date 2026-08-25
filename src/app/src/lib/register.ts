import { createInterface } from "readline";
import { DEV_PASSWORD } from "@alook/shared";
import { SELF_HOSTED_DIR } from "./constants.js";
import { join } from "path";

interface SignupResult {
  sessionCookie: string;
  userId: string;
}

interface PairingTokenResult {
  tokenId: string;
  expiresAt: string;
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

function extractSession(res: Response): { sessionCookie: string; userId: string } | null {
  const cookies = res.headers.getSetCookie?.() || [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token")) || "";
  if (!sessionCookie) return null;
  return { sessionCookie, userId: "" };
}

export async function collectEmail(): Promise<string> {
  const { userInfo } = await import("os");
  const defaultEmail = `${userInfo().username || "user"}@local.alook`;
  console.log("\n📝 Create your account:\n");
  const input = await prompt(`  Email (${defaultEmail}): `);
  return input.trim() || defaultEmail;
}

export async function registerUser(baseURL: string, email: string): Promise<SignupResult> {
  const { userInfo } = await import("os");
  const name = userInfo().username || "User";
  const password = DEV_PASSWORD;

  let res = await fetch(`${baseURL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseURL },
    body: JSON.stringify({ email, password, name }),
    redirect: "manual",
  });

  if (!res.ok) {
    const text = await res.text();
    if (text.includes("already exists") || text.includes("already registered") || text.includes("User already")) {
      res = await fetch(`${baseURL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseURL },
        body: JSON.stringify({ email, password }),
        redirect: "manual",
      });

      if (!res.ok) {
        console.error(`\nError: account exists but could not sign in.`);
        console.error(`Open ${baseURL} in browser and sign in manually.`);
        process.exit(1);
      }

      const session = extractSession(res);
      if (!session) {
        console.error(`\nError: account exists but could not get session.`);
        console.error(`Open ${baseURL} in browser and sign in manually.`);
        process.exit(1);
      }
      console.log(`  ✓ Signed in (${email})`);
      return session;
    }
    console.error(`\nError: signup failed (${res.status}): ${text}`);
    process.exit(1);
  }

  const session = extractSession(res);
  if (!session) {
    console.error("\nError: no session cookie received after signup");
    process.exit(1);
  }

  console.log(`  ✓ Account created (${email})`);
  return session;
}

export async function createPairingToken(baseURL: string, cookie: string): Promise<PairingTokenResult> {
  const res = await fetch(`${baseURL}/api/community/machines/pair`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseURL,
      Cookie: cookie,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`failed to create community pairing token (${res.status}): ${text}`);
  }

  const result = (await res.json()) as Partial<PairingTokenResult>;
  if (typeof result.tokenId !== "string" || !result.tokenId.startsWith("cmt_")) {
    throw new Error("community pairing endpoint returned an invalid token");
  }
  return result as PairingTokenResult;
}

export async function waitForServer(baseURL: string, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let dots = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/api/auth/session`, { method: "GET" });
      if (res.status < 500) return;
    } catch {}
    dots++;
    if (dots % 10 === 0) {
      process.stdout.write("  still starting...\n");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error("Error: server did not start within 90 seconds");
  console.error(`Check logs at ${join(SELF_HOSTED_DIR, "logs", "web.log")}`);
  process.exit(1);
}
