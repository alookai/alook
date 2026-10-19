async function fetchLatestPackageVersion(pkg: string): Promise<{ version: string; package: string } | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    if (!data.version) return null;
    return { version: data.version, package: pkg };
  } catch {
    return null;
  }
}

export function fetchLatestDaemonVersion(): Promise<{ version: string; package: string } | null> {
  return fetchLatestPackageVersion("@alook/daemon")
}
