import { NextResponse } from "next/server";

const GITHUB_REPO = "alookai/alook";
const TAG_PREFIX = "desktop-v";
const CACHE_TTL = 300;

const PLATFORM_MAP: Record<string, string> = {
  "darwin-aarch64": ".app.tar.gz",
  "darwin-x86_64": ".app.tar.gz",
  "linux-x86_64": ".AppImage.tar.gz",
  "windows-x86_64": ".msi.zip",
};

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ target: string; arch: string; current_version: string }> },
) {
  const { target, arch, current_version } = await params;
  const platformKey = `${target}-${arch}`;

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`,
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "alook-updater",
      },
      next: { revalidate: CACHE_TTL },
    },
  );

  if (!res.ok) {
    return NextResponse.json({ error: "Failed to fetch releases" }, { status: 502 });
  }

  interface GitHubRelease {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    assets: { name: string; browser_download_url: string }[];
    body: string | null;
    published_at: string | null;
  }

  const releases = (await res.json()) as GitHubRelease[];
  const desktopRelease = releases.find(
    (r) => !r.draft && !r.prerelease && r.tag_name?.startsWith(TAG_PREFIX),
  );

  if (!desktopRelease) {
    return new NextResponse(null, { status: 204 });
  }

  const latestVersion = desktopRelease.tag_name.replace(TAG_PREFIX, "");
  if (compareVersions(latestVersion, current_version) <= 0) {
    return new NextResponse(null, { status: 204 });
  }

  const suffix = PLATFORM_MAP[platformKey];
  if (!suffix) {
    return new NextResponse(null, { status: 204 });
  }

  const assets = desktopRelease.assets;
  const binary = assets.find((a) => a.name.endsWith(suffix) && !a.name.endsWith(".sig"));
  const sig = assets.find((a) => a.name.endsWith(`${suffix}.sig`));

  if (!binary || !sig) {
    return new NextResponse(null, { status: 204 });
  }

  const sigRes = await fetch(sig.browser_download_url);
  const signature = sigRes.ok ? await sigRes.text() : "";

  const platforms: Record<string, { url: string; signature: string }> = {};
  platforms[platformKey] = {
    url: binary.browser_download_url,
    signature,
  };

  return NextResponse.json(
    {
      version: latestVersion,
      notes: desktopRelease.body || "",
      pub_date: desktopRelease.published_at,
      platforms,
    },
    {
      headers: { "Cache-Control": `public, max-age=${CACHE_TTL}` },
    },
  );
}
