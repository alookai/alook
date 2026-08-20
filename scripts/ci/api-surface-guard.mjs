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

export function isApiSurfacePath(path) {
  return path.startsWith(API_REPORT_PREFIX) || API_SOURCE_PATHS.has(path);
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

export function evaluateApiSurfaceGuard(input) {
  const changedApiPaths = input.changedPaths.filter(isApiSurfacePath);
  if (changedApiPaths.length === 0) return { ok: true, reason: "no_api_surface_change" };

  const selectedLabels = API_LABELS.filter((label) => input.labels.includes(label));
  if (selectedLabels.length !== 1) {
    return { ok: false, reason: "exactly_one_api_label_required", changedApiPaths };
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
    return { ok: false, reason: "current_head_independent_owner_approval_required", changedApiPaths };
  }

  const adapterAuthorReportChanged = changedApiPaths.includes(`${API_REPORT_PREFIX}adapter-author.api.md`);
  if (selectedLabels[0] === "api-breaking" && adapterAuthorReportChanged) {
    const isInitialVersion = input.baseContractVersion === null && input.headContractVersion === 1;
    const isIncrement = Number.isInteger(input.baseContractVersion)
      && Number.isInteger(input.headContractVersion)
      && input.headContractVersion > input.baseContractVersion;
    if (!isInitialVersion && !isIncrement) {
      return { ok: false, reason: "adapter_author_contract_version_must_increase", changedApiPaths };
    }
  }

  return { ok: true, reason: "approved", approver: approver.login, changedApiPaths };
}

async function githubJson(url, token, allowNotFound = false) {
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

async function fetchAllPages(repository, pullNumber, resource, token) {
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

async function fetchAllReviews(repository, pullNumber, token) {
  const reviews = await fetchAllPages(repository, pullNumber, "reviews", token);
  return reviews.filter((review) => review.user?.login).map((review) => ({
    id: review.id,
    login: review.user.login,
    state: review.state,
    commitId: review.commit_id,
  }));
}

async function contractVersionAt(repository, sha, token) {
  const path = "src/daemon/agent-driver/src/adapter-author.ts";
  const value = await githubJson(
    `https://api.github.com/repos/${repository}/contents/${path}?ref=${sha}`,
    token,
    true,
  );
  if (!value?.content || value.encoding !== "base64") return null;
  const source = Buffer.from(value.content, "base64").toString("utf8");
  const match = source.match(/ADAPTER_AUTHOR_CONTRACT_VERSION\s*=\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

async function main() {
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
