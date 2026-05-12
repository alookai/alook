import { createInterface } from "readline";

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

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      process.stdout.write(question);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      if (stdin.isTTY) stdin.setRawMode(true);
      let input = "";
      const onData = (char: Buffer) => {
        const c = char.toString();
        if (c === "\n" || c === "\r") {
          stdin.removeListener("data", onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          process.stdout.write("\n");
          rl.close();
          resolve(input);
        } else if (c === "\u0003") {
          process.exit(0);
        } else if (c === "\u0008") {
          input = input.slice(0, -1);
        } else {
          input += c;
        }
      };
      stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
    }
  });
}

export async function collectEmail(): Promise<string> {
  const { userInfo } = await import("os");
  const defaultEmail = `${userInfo().username || "user"}@localhost`;
  console.log("\n📝 Create your account:\n");
  const input = await prompt(`  Email (${defaultEmail}): `);
  return input.trim() || defaultEmail;
}

export async function registerUser(baseURL: string, email: string): Promise<SignupResult> {
  const { userInfo } = await import("os");
  const { randomBytes } = await import("crypto");
  const name = userInfo().username || "User";
  const password = randomBytes(24).toString("base64");

  const res = await fetch(`${baseURL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
    redirect: "manual",
  });

  if (!res.ok && res.status !== 302) {
    const text = await res.text();
    console.error(`\nError: signup failed (${res.status}): ${text}`);
    process.exit(1);
  }

  const cookies = res.headers.getSetCookie?.() || [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token")) || "";

  if (!sessionCookie) {
    console.error("\nError: no session cookie received after signup");
    process.exit(1);
  }

  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  const userId = (body as { user?: { id?: string } }).user?.id || "";

  console.log(`\n  ✓ Account created (${email})`);
  return { sessionCookie, userId };
}

export async function createWorkspace(baseURL: string, cookie: string): Promise<WorkspaceResult> {
  const res = await fetch(`${baseURL}/api/workspaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ name: "Personal", slug: "personal" }),
  });

  if (!res.ok) {
    const listRes = await fetch(`${baseURL}/api/workspaces`, {
      headers: { Cookie: cookie },
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
      Cookie: cookie,
    },
    body: JSON.stringify({ name: "local-onboard" }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Error: failed to create machine token (${res.status}): ${text}`);
    process.exit(1);
  }

  const data = (await res.json()) as TokenResult;
  return data;
}

export async function activateToken(
  baseURL: string,
  token: string,
  runtimes: RuntimeInfo[],
): Promise<{ workspaceId: string; runtimeIds: string[] }> {
  const { hostname } = await import("os");

  const res = await fetch(`${baseURL}/api/machine-tokens/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

export async function waitForServer(baseURL: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/api/auth/session`, { method: "GET" });
      if (res.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error("Error: server did not start within 30 seconds");
  console.error(`Check logs at ~/.alook/self-hosted/logs/web.log`);
  process.exit(1);
}
