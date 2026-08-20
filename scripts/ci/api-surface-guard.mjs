import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_LABELS = ["api-additive", "api-breaking"];
const API_REPORT_PREFIX = "src/daemon/agent-driver/etc/api/";
const API_SOURCE_PATHS = new Set([
  "src/daemon/agent-driver/src/index.ts",
  "src/daemon/agent-driver/src/host.ts",
  "src/daemon/agent-driver/src/adapter-author.ts",
  "src/daemon/agent-driver/src/testing/index.ts",
  "src/daemon/agent-driver/src/testing/conformance.ts",
  "src/daemon/agent-driver/src/testing/fake-host.ts",
  "src/daemon/agent-driver/src/public-contract.ts",
  "src/daemon/agent-driver/src/public-sdk.ts",
  "src/daemon/agent-driver/src/contract.ts",
  "src/daemon/agent-driver/src/registry.ts",
  "src/daemon/agent-driver/src/internal/adapter.ts",
]);
const API_MECHANISM_PATHS = new Set([
  ".github/CODEOWNERS",
  ".github/api-surface-owners.json",
  ".github/workflows/api-surface-check.yml",
  ".github/workflows/api-surface-guard.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/ci/api-report-contract.test.ts",
  "scripts/ci/api-surface-guard.mjs",
  "scripts/ci/api-surface-guard.test.ts",
  "src/daemon/agent-driver/api-extractor.adapter-author.json",
  "src/daemon/agent-driver/api-extractor.host.json",
  "src/daemon/agent-driver/api-extractor.root.json",
  "src/daemon/agent-driver/api-extractor.testing.json",
  "src/daemon/agent-driver/package.json",
  "src/daemon/agent-driver/scripts/api-reports.mjs",
  "src/daemon/agent-driver/scripts/prepare-dist.mjs",
  "src/daemon/agent-driver/scripts/prune-dist.mjs",
  "src/daemon/agent-driver/tsconfig.build.json",
  "src/daemon/agent-driver/tsconfig.json",
  "vitest.config.ts",
]);

export function isApiSurfacePath(path) {
  return path.startsWith(API_REPORT_PREFIX) || API_SOURCE_PATHS.has(path);
}

export function isApiMechanismPath(path) {
  return API_MECHANISM_PATHS.has(path);
}

export function collectChangedPaths(files, expectedChangedFileCount) {
  if (!Array.isArray(files)) throw new Error("Invalid pull request files response");
  if (!Number.isSafeInteger(expectedChangedFileCount) || expectedChangedFileCount < 0) {
    throw new Error("Invalid pull request changed_files count");
  }

  const returnedFileNames = new Set();
  const changedPaths = new Set();
  for (const file of files) {
    if (!file || typeof file.filename !== "string" || file.filename.length === 0) {
      throw new Error("Invalid pull request file entry");
    }
    returnedFileNames.add(file.filename);
    changedPaths.add(file.filename);
    if (file.previous_filename !== undefined) {
      if (typeof file.previous_filename !== "string" || file.previous_filename.length === 0) {
        throw new Error("Invalid pull request previous filename");
      }
      changedPaths.add(file.previous_filename);
    }
  }

  if (returnedFileNames.size !== expectedChangedFileCount) {
    throw new Error(
      `Incomplete pull request files response: expected ${expectedChangedFileCount}, received ${returnedFileNames.size}`,
    );
  }
  return [...changedPaths];
}

export function parseAdapterAuthorContractVersion(source) {
  const identifier = "ADAPTER_AUTHOR_CONTRACT_VERSION";
  const occurrences = source.match(new RegExp(`\\b${identifier}\\b`, "g")) ?? [];
  if (occurrences.length === 0) return null;
  if (occurrences.length > 1) throw new Error("Multiple adapter-author contract version references");

  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (offset < source.length) {
    const remainder = source.slice(offset);
    const whitespace = remainder.match(/^\s+/);
    if (whitespace) {
      offset += whitespace[0].length;
      continue;
    }
    if (remainder.startsWith("//")) {
      const newline = remainder.indexOf("\n");
      offset += newline === -1 ? remainder.length : newline + 1;
      continue;
    }
    if (remainder.startsWith("/*")) {
      const end = remainder.indexOf("*/", 2);
      if (end === -1) throw new Error("Unterminated leading comment in adapter-author contract source");
      offset += end + 2;
      continue;
    }
    break;
  }

  const declaration = source.slice(offset).match(
    /^export[\t ]+const[\t ]+ADAPTER_AUTHOR_CONTRACT_VERSION[\t ]*=[\t ]*(\d+)(?:[\t ]+as[\t ]+const)?[\t ]*;?[\t ]*(?:\r?\n|$)/,
  );
  if (!declaration) throw new Error("Invalid adapter-author contract version declaration");
  const version = Number(declaration[1]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Invalid adapter-author contract version declaration");
  }
  return version;
}

export function evaluateApiSurfaceGuard(input) {
  const changedApiPaths = input.changedPaths.filter(isApiSurfacePath);
  const changedMechanismPaths = input.changedPaths.filter(isApiMechanismPath);
  if (changedApiPaths.length === 0 && changedMechanismPaths.length === 0) {
    return { ok: true, reason: "no_api_surface_change" };
  }

  const selectedLabels = API_LABELS.filter((label) => input.labels.includes(label));
  const adapterAuthorReportChanged = changedApiPaths.includes(`${API_REPORT_PREFIX}adapter-author.api.md`);
  let baseVersion;
  let headVersion;
  let baseHasVersion;
  let headHasVersion;
  if (changedApiPaths.length > 0) {
    baseVersion = input.baseContractVersion;
    headVersion = input.headContractVersion;
    baseHasVersion = Number.isSafeInteger(baseVersion) && baseVersion >= 1;
    headHasVersion = Number.isSafeInteger(headVersion) && headVersion >= 1;
    if ((baseVersion !== null && !baseHasVersion) || (headVersion !== null && !headHasVersion)) {
      return { ok: false, reason: "invalid_adapter_author_contract_version", changedApiPaths };
    }
    if (baseHasVersion && (!headHasVersion || headVersion < baseVersion)) {
      return { ok: false, reason: "adapter_author_contract_version_must_not_regress", changedApiPaths };
    }
    if (baseHasVersion && headHasVersion && headVersion > baseVersion) {
      const isBreakingReportChange = adapterAuthorReportChanged
        && selectedLabels.length === 1
        && selectedLabels[0] === "api-breaking";
      if (!isBreakingReportChange) {
        return { ok: false, reason: "adapter_author_contract_version_bump_requires_breaking_report", changedApiPaths };
      }
    }
    if (adapterAuthorReportChanged && !headHasVersion) {
      return { ok: false, reason: "adapter_author_contract_version_required", changedApiPaths };
    }
    if (baseVersion === null && headHasVersion) {
      const isBreakingBootstrap = adapterAuthorReportChanged
        && selectedLabels.length === 1
        && selectedLabels[0] === "api-breaking"
        && headVersion === 1;
      if (!isBreakingBootstrap) {
        return { ok: false, reason: "adapter_author_contract_version_bootstrap_requires_breaking_v1", changedApiPaths };
      }
    }
    if (selectedLabels.length !== 1) {
      return { ok: false, reason: "exactly_one_api_label_required", changedApiPaths };
    }
  }

  const latestByReviewer = new Map();
  for (const review of [...input.reviews].sort((a, b) => a.id - b.id)) {
    latestByReviewer.set(review.login.toLowerCase(), review);
  }
  const author = input.prAuthor.toLowerCase();
  const owners = new Set(input.owners.map((owner) => owner.toLowerCase()));
  const approver = [...latestByReviewer.values()].find((review) =>
    owners.has(review.login.toLowerCase())
    && review.login.toLowerCase() !== author
    && review.state === "APPROVED"
    && review.commitId === input.headSha
  );
  if (!approver) {
    return {
      ok: false,
      reason: "current_head_independent_owner_approval_required",
      changedApiPaths,
      changedMechanismPaths,
    };
  }

  if (selectedLabels[0] === "api-breaking" && adapterAuthorReportChanged) {
    const isInitialVersion = baseVersion === null && headVersion === 1;
    const isIncrement = baseHasVersion && headHasVersion && headVersion > baseVersion;
    if (!isInitialVersion && !isIncrement) {
      return { ok: false, reason: "adapter_author_contract_version_must_increase", changedApiPaths };
    }
  }

  return { ok: true, reason: "approved", approver: approver.login, changedApiPaths, changedMechanismPaths };
}

export async function githubJson(url, token, allowNotFound = false) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API failed: ${response.status}`);
  return response.json();
}

export async function fetchAllPages(repository, pullNumber, resource, token) {
  const values = [];
  for (let page = 1; ; page += 1) {
    const pageValues = await githubJson(
      `https://api.github.com/repos/${repository}/pulls/${pullNumber}/${resource}?per_page=100&page=${page}`,
      token,
    );
    values.push(...pageValues);
    if (pageValues.length < 100) break;
  }
  return values;
}

export async function fetchAllReviews(repository, pullNumber, token) {
  const reviews = await fetchAllPages(repository, pullNumber, "reviews", token);
  return reviews.filter((review) => review.user?.login).map((review) => ({
    id: review.id,
    login: review.user.login,
    state: review.state,
    commitId: review.commit_id,
  }));
}

export async function contractVersionAt(repository, sha, token) {
  const path = "src/daemon/agent-driver/src/adapter-author.ts";
  const value = await githubJson(
    `https://api.github.com/repos/${repository}/contents/${path}?ref=${sha}`,
    token,
    true,
  );
  if (!value?.content || value.encoding !== "base64") return null;
  const source = Buffer.from(value.content, "base64").toString("utf8");
  return parseAdapterAuthorContractVersion(source);
}

export async function main() {
  const required = ["API_BASE_SHA", "API_HEAD_SHA", "API_PR_AUTHOR", "API_PR_NUMBER", "API_REPOSITORY", "API_GITHUB_TOKEN"];
  for (const name of required) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }
  const baseSha = process.env.API_BASE_SHA;
  const headSha = process.env.API_HEAD_SHA;
  if (!/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error("Invalid base/head SHA");
  }
  const repository = process.env.API_REPOSITORY;
  const pullNumber = process.env.API_PR_NUMBER;
  const token = process.env.API_GITHUB_TOKEN;
  const pull = await githubJson(`https://api.github.com/repos/${repository}/pulls/${pullNumber}`, token);
  if (pull.base.sha !== baseSha || pull.head.sha !== headSha || pull.user.login !== process.env.API_PR_AUTHOR) {
    throw new Error("Pull request identity changed while evaluating API approval");
  }
  const changedPaths = collectChangedPaths(
    await fetchAllPages(repository, pullNumber, "files", token),
    pull.changed_files,
  );
  const labels = JSON.parse(process.env.API_LABELS_JSON ?? "[]").map((label) =>
    typeof label === "string" ? label : label.name
  );
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const ownerConfig = JSON.parse(await readFile(resolve(scriptRoot, ".github/api-surface-owners.json"), "utf8"));
  const reviews = await fetchAllReviews(repository, pullNumber, token);
  const result = evaluateApiSurfaceGuard({
    changedPaths,
    labels,
    reviews,
    owners: ownerConfig.owners,
    prAuthor: process.env.API_PR_AUTHOR,
    headSha,
    baseContractVersion: await contractVersionAt(repository, baseSha, token),
    headContractVersion: await contractVersionAt(repository, headSha, token),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
