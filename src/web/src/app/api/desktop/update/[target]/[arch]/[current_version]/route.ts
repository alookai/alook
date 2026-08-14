import { NextResponse } from "next/server";

const GITHUB_REPO = "alookai/alook";
const TAG_PREFIX = "v";
const CACHE_TTL = 300;

interface PlatformSpec {
  suffix: string;
  architecture: RegExp;
}

const PLATFORM_MAP: Record<string, PlatformSpec> = {
  "darwin-aarch64-app": {
    suffix: ".app.tar.gz",
    architecture: /(?:^|[._-])aarch64(?:[._-]|$)/i,
  },
  "darwin-x86_64-app": {
    suffix: ".app.tar.gz",
    architecture: /(?:^|[._-])(?:x64|x86_64)(?:[._-]|$)/i,
  },
  "linux-x86_64-appimage": {
    suffix: ".AppImage",
    architecture: /(?:^|[._-])(?:amd64|x64|x86_64)(?:[._-]|$)/i,
  },
  "linux-x86_64-deb": {
    suffix: ".deb",
    architecture: /(?:^|[._-])(?:amd64|x64|x86_64)(?:[._-]|$)/i,
  },
  "linux-x86_64-rpm": {
    suffix: ".rpm",
    architecture: /(?:^|[._-])(?:amd64|x64|x86_64)(?:[._-]|$)/i,
  },
  "windows-x86_64-msi": {
    suffix: ".msi",
    architecture: /(?:^|[._-])(?:x64|x86_64)(?:[._-]|$)/i,
  },
  "windows-x86_64-nsis": {
    suffix: "-setup.exe",
    architecture: /(?:^|[._-])(?:x64|x86_64)(?:[._-]|$)/i,
  },
};

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

function findPlatformBinary(assets: GitHubAsset[], spec: PlatformSpec) {
  return assets.find(
    (asset) =>
      !asset.name.endsWith(".sig") &&
      asset.name.endsWith(spec.suffix) &&
      spec.architecture.test(asset.name),
  );
}

function findPlatformAssets(assets: GitHubAsset[], spec: PlatformSpec) {
  const binary = findPlatformBinary(assets, spec);
  const signature = binary
    ? assets.find((asset) => asset.name === `${binary.name}.sig`)
    : undefined;
  return binary && signature ? { binary, signature } : null;
}

function parseStableSemver(version: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    version,
  );
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const na = a[i];
    const nb = b[i];
    if (na !== nb) return na - nb;
  }
  return 0;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ target: string; arch: string; current_version: string }> },
) {
  const { target, arch, current_version } = await params;
  const bundleType = new URL(req.url).searchParams.get("bundle_type");
  const platformKey = `${target}-${arch}-${bundleType}`;
  const platform = PLATFORM_MAP[platformKey];
  const currentVersion = parseStableSemver(current_version);
  if (!platform || !currentVersion) {
    return new NextResponse(null, { status: 204 });
  }

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100`,
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
    assets: GitHubAsset[];
    body: string | null;
    published_at: string | null;
  }

  const releases = (await res.json()) as GitHubRelease[];
  const candidates = releases.flatMap((release) => {
    if (release.draft || release.prerelease || !release.tag_name?.startsWith(TAG_PREFIX)) {
      return [];
    }
    const versionText = release.tag_name.slice(TAG_PREFIX.length);
    const version = parseStableSemver(versionText);
    const assets = findPlatformAssets(release.assets, platform);
    return version && assets ? [{ release, version, versionText, ...assets }] : [];
  });
  const desktopRelease = candidates.reduce<(typeof candidates)[number] | null>(
    (latest, candidate) =>
      !latest || compareVersions(candidate.version, latest.version) > 0 ? candidate : latest,
    null,
  );

  if (!desktopRelease) {
    return new NextResponse(null, { status: 204 });
  }

  if (compareVersions(desktopRelease.version, currentVersion) <= 0) {
    return new NextResponse(null, { status: 204 });
  }

  let signature: string;
  try {
    const sigRes = await fetch(desktopRelease.signature.browser_download_url);
    if (!sigRes.ok) {
      return NextResponse.json({ error: "Failed to fetch update signature" }, { status: 502 });
    }
    signature = (await sigRes.text()).trim();
  } catch {
    return NextResponse.json({ error: "Failed to fetch update signature" }, { status: 502 });
  }
  if (!signature) {
    return NextResponse.json({ error: "Update signature is empty" }, { status: 502 });
  }

  const platforms: Record<string, { url: string; signature: string }> = {};
  platforms[platformKey] = {
    url: desktopRelease.binary.browser_download_url,
    signature,
  };

  return NextResponse.json(
    {
      version: desktopRelease.versionText,
      notes: desktopRelease.release.body || "",
      pub_date: desktopRelease.release.published_at,
      platforms,
    },
    {
      headers: { "Cache-Control": `public, max-age=${CACHE_TTL}` },
    },
  );
}
