import { createInterface } from "readline";
import { DEV_PASSWORD } from "@alook/shared";
import { SELF_HOSTED_DIR } from "./constants.js";
import { join } from "path";

interface SignupResult {
  sessionCookie: string;
  userId: string;
}

interface WorkspaceResult {
  id: string;
  name: string;
  slug: string;
}

interface TokenResult {
  token: string;
  id: string;
}

interface RuntimeInfo {
  type: string;
  version: string;
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

export async function createWorkspace(baseURL: string, cookie: string): Promise<WorkspaceResult> {
  const res = await fetch(`${baseURL}/api/workspaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseURL,
      Cookie: cookie,
    },
    body: JSON.stringify({ name: "Personal", slug: "personal" }),
  });

  if (!res.ok) {
    const listRes = await fetch(`${baseURL}/api/workspaces`, {
      headers: { Cookie: cookie, Origin: baseURL },
    });
    if (listRes.ok) {
      const workspaces = (await listRes.json()) as WorkspaceResult[];
      if (workspaces.length > 0) return workspaces[0];
    }
    console.error("Error: failed to create workspace");
    process.exit(1);
  }

  const ws = (await res.json()) as WorkspaceResult;
  console.log(`  ✓ Workspace "${ws.name}" ready`);
  return ws;
}

export async function createMachineToken(
  baseURL: string,
  cookie: string,
  workspaceId: string,
): Promise<TokenResult> {
  const res = await fetch(`${baseURL}/api/machine-tokens?workspace_id=${workspaceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseURL,
      Cookie: cookie,
    },
    body: JSON.stringify({ name: "local-onboard" }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Error: failed to create machine token (${res.status}): ${text}`);
    process.exit(1);
  }

  return (await res.json()) as TokenResult;
}

export async function activateToken(
  baseURL: string,
  token: string,
  runtimes: RuntimeInfo[],
): Promise<{ workspaceId: string; runtimeIds: string[] }> {
  const { hostname } = await import("os");

  const res = await fetch(`${baseURL}/api/machine-tokens/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseURL },
    body: JSON.stringify({
      token,
      hostname: hostname(),
      runtimes,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Error: failed to activate token (${res.status}): ${text}`);
    process.exit(1);
  }

  const data = (await res.json()) as {
    workspace_id: string;
    runtimes: { id: string; provider: string }[];
  };

  return {
    workspaceId: data.workspace_id,
    runtimeIds: data.runtimes.map((r) => r.id),
  };
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
