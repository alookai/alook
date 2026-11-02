import { NextResponse } from "next/server";
import { compareVersions, fetchGitHubReleases, parseStableSemver, RELEASE_CACHE_SECONDS, type GitHubAsset, type GitHubRelease } from "@/lib/github-releases";

const TAG_PREFIX = "v";
const CACHE_TTL = RELEASE_CACHE_SECONDS;

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

  const res = await fetchGitHubReleases();

  if (!res.ok) {
    return NextResponse.json({ error: "Failed to fetch releases" }, { status: 502 });
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
