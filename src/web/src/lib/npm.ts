export async function fetchLatestCliVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/@alook/cli/latest");
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}
