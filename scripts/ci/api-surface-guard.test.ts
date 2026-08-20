import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectChangedPaths,
  contractVersionAt,
  evaluateApiSurfaceGuard,
  fetchAllPages,
  fetchAllReviews,
  githubJson,
  main,
  parseAdapterAuthorContractVersion,
} from "./api-surface-guard.mjs";

const headSha = "b".repeat(40);
const publicSource = "src/daemon/agent-driver/src/adapter-author.ts";
const golden = "src/daemon/agent-driver/etc/api/adapter-author.api.md";
const ownerApproval = { id: 1, login: "independent-owner", state: "APPROVED", commitId: headSha };

const requiredCliEnv = {
  API_BASE_SHA: "a".repeat(40),
  API_HEAD_SHA: headSha,
  API_PR_AUTHOR: "author",
  API_PR_NUMBER: "510",
  API_REPOSITORY: "alookai/alook",
  API_GITHUB_TOKEN: "test-token",
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function stubCliEnv(labels?: unknown[]) {
  for (const [name, value] of Object.entries(requiredCliEnv)) vi.stubEnv(name, value);
  if (labels === undefined) delete process.env.API_LABELS_JSON;
  else vi.stubEnv("API_LABELS_JSON", JSON.stringify(labels));
}

function contractSource(version: number) {
  return Buffer.from(`export const ADAPTER_AUTHOR_CONTRACT_VERSION = ${version} as const;\n`).toString("base64");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

function evaluate(overrides: Record<string, unknown> = {}) {
  return evaluateApiSurfaceGuard({
    changedPaths: [publicSource],
    labels: ["api-additive"],
    reviews: [ownerApproval],
    owners: ["author", "independent-owner"],
    prAuthor: "author",
    headSha,
    baseContractVersion: 1,
    headContractVersion: 1,
    ...overrides,
  } as never);
}

describe("api surface approval guard", () => {
  it("requires exactly one API change label for public source", () => {
    expect(evaluate({ labels: [] })).toMatchObject({ ok: false, reason: "exactly_one_api_label_required" });
    expect(evaluate({ labels: ["api-additive", "api-breaking"] }))
      .toMatchObject({ ok: false, reason: "exactly_one_api_label_required" });
  });

  it("rejects source plus golden drift without an independent current-head owner approval", () => {
    expect(evaluate({ changedPaths: [publicSource, golden], reviews: [] }))
      .toMatchObject({ ok: false, reason: "current_head_independent_owner_approval_required" });
    expect(evaluate({ reviews: [{ ...ownerApproval, login: "author" }] }))
      .toMatchObject({ ok: false, reason: "current_head_independent_owner_approval_required" });
    expect(evaluate({ reviews: [{ ...ownerApproval, commitId: "a".repeat(40) }] }))
      .toMatchObject({ ok: false, reason: "current_head_independent_owner_approval_required" });
  });

  it("accepts an allow-listed independent approval on the exact head", () => {
    expect(evaluate({
      reviews: [
        { ...ownerApproval, id: 2 },
        { ...ownerApproval, id: 1, state: "CHANGES_REQUESTED" },
      ],
    })).toMatchObject({ ok: true, reason: "approved", approver: "independent-owner" });
  });

  it("allows only version 1 when bootstrapping the adapter-author contract", () => {
    expect(evaluate({
      changedPaths: [golden],
      labels: ["api-breaking"],
      baseContractVersion: null,
      headContractVersion: 1,
    })).toMatchObject({ ok: true });
    expect(evaluate({
      changedPaths: [golden],
      labels: ["api-breaking"],
      baseContractVersion: null,
      headContractVersion: 2,
    })).toMatchObject({ ok: false, reason: "adapter_author_contract_version_bootstrap_requires_breaking_v1" });
    expect(evaluate({
      changedPaths: [golden],
      labels: ["api-additive"],
      baseContractVersion: null,
      headContractVersion: 1,
    })).toMatchObject({ ok: false, reason: "adapter_author_contract_version_bootstrap_requires_breaking_v1" });
    expect(evaluate({
      changedPaths: [golden],
      labels: [],
      baseContractVersion: null,
      headContractVersion: 1,
    })).toMatchObject({ ok: false, reason: "adapter_author_contract_version_bootstrap_requires_breaking_v1" });
  });

  it("requires an established adapter-author contract version to increase for a breaking report", () => {
    expect(evaluate({
      changedPaths: [golden],
      labels: ["api-breaking"],
      baseContractVersion: 1,
      headContractVersion: 1,
    })).toMatchObject({ ok: false, reason: "adapter_author_contract_version_must_increase" });
    expect(evaluate({
      changedPaths: [golden],
      labels: ["api-breaking"],
      baseContractVersion: 1,
      headContractVersion: 2,
    })).toMatchObject({ ok: true });
  });

  it("forbids established contract removal or regression regardless of the API label", () => {
    for (const labels of [["api-additive"], ["api-breaking"], []]) {
      expect(evaluate({
        changedPaths: [golden],
        labels,
        baseContractVersion: 2,
        headContractVersion: 1,
      })).toMatchObject({ ok: false, reason: "adapter_author_contract_version_must_not_regress" });
      expect(evaluate({
        changedPaths: [golden],
        labels,
        baseContractVersion: 1,
        headContractVersion: null,
      })).toMatchObject({ ok: false, reason: "adapter_author_contract_version_must_not_regress" });
    }
  });

  it("allows established version bumps only for a breaking adapter-author report", () => {
    expect(evaluate({
      changedPaths: [golden],
      labels: ["api-additive"],
      baseContractVersion: 1,
      headContractVersion: 2,
    })).toMatchObject({ ok: false, reason: "adapter_author_contract_version_bump_requires_breaking_report" });
    expect(evaluate({
      changedPaths: [publicSource],
      labels: ["api-breaking"],
      baseContractVersion: 1,
      headContractVersion: 2,
    })).toMatchObject({ ok: false, reason: "adapter_author_contract_version_bump_requires_breaking_report" });
    expect(evaluate({
      changedPaths: [golden],
      labels: [],
      baseContractVersion: 1,
      headContractVersion: 2,
    })).toMatchObject({ ok: false, reason: "adapter_author_contract_version_bump_requires_breaking_report" });
  });

  it("reads one canonical contract declaration as the first non-comment statement", () => {
    expect(parseAdapterAuthorContractVersion([
      "/** Adapter-author contract version. */",
      "export const ADAPTER_AUTHOR_CONTRACT_VERSION = 1 as const;",
      "export type Example = string;",
    ].join("\n"))).toBe(1);
    expect(parseAdapterAuthorContractVersion([
      "\ufeff // leading line comment",
      "export const ADAPTER_AUTHOR_CONTRACT_VERSION = 2;",
    ].join("\n"))).toBe(2);
    expect(parseAdapterAuthorContractVersion("export type Example = string;\n")).toBeNull();
  });

  it("rejects comment and string decoys instead of reading them as a bump", () => {
    expect(() => parseAdapterAuthorContractVersion([
      "// ADAPTER_AUTHOR_CONTRACT_VERSION = 2",
      "export const ADAPTER_AUTHOR_CONTRACT_VERSION = 1 as const;",
    ].join("\n"))).toThrow("Multiple adapter-author contract version references");
    expect(() => parseAdapterAuthorContractVersion([
      "const decoy = `export const ADAPTER_AUTHOR_CONTRACT_VERSION = 2`;",
      "export const ADAPTER_AUTHOR_CONTRACT_VERSION = 1 as const;",
    ].join("\n"))).toThrow("Multiple adapter-author contract version references");
    expect(() => parseAdapterAuthorContractVersion(
      "const decoy = 'ADAPTER_AUTHOR_CONTRACT_VERSION = 2';",
    )).toThrow("Invalid adapter-author contract version declaration");
  });

  it("fails closed on multiple exported contract declarations", () => {
    expect(() => parseAdapterAuthorContractVersion([
      "export const ADAPTER_AUTHOR_CONTRACT_VERSION = 1",
      "export const ADAPTER_AUTHOR_CONTRACT_VERSION = 2",
    ].join("\n"))).toThrow("Multiple adapter-author contract version references");
    expect(() => parseAdapterAuthorContractVersion(
      "/* ADAPTER_AUTHOR_CONTRACT_VERSION",
    )).toThrow("Unterminated leading comment in adapter-author contract source");
    expect(() => parseAdapterAuthorContractVersion(
      "export const ADAPTER_AUTHOR_CONTRACT_VERSION = 0;",
    )).toThrow("Invalid adapter-author contract version declaration");
    expect(() => parseAdapterAuthorContractVersion(
      "export const ADAPTER_AUTHOR_CONTRACT_VERSION = 999999999999999999999999;",
    )).toThrow("Invalid adapter-author contract version declaration");
  });

  it("includes a rename's protected previous path without inflating the returned file count", () => {
    const changedPaths = collectChangedPaths([{
      filename: "src/daemon/agent-driver/src/internal/legacy-adapter-author.ts",
      previous_filename: publicSource,
    }], 1);
    expect(changedPaths).toEqual([
      "src/daemon/agent-driver/src/internal/legacy-adapter-author.ts",
      publicSource,
    ]);
    expect(evaluate({ changedPaths, labels: [], reviews: [] }))
      .toMatchObject({ ok: false, reason: "exactly_one_api_label_required" });
  });

  it("fails closed when the pull request files response is incomplete", () => {
    expect(() => collectChangedPaths([
      { filename: "src/daemon/agent-driver/src/adapters/claude/index.ts" },
    ], 2)).toThrow("Incomplete pull request files response: expected 2, received 1");
    expect(() => collectChangedPaths(null as never, 0)).toThrow("Invalid pull request files response");
    expect(() => collectChangedPaths([], -1)).toThrow("Invalid pull request changed_files count");
    expect(() => collectChangedPaths([null] as never, 1)).toThrow("Invalid pull request file entry");
    expect(() => collectChangedPaths([{ filename: publicSource, previous_filename: "" }], 1))
      .toThrow("Invalid pull request previous filename");
  });

  it("rejects invalid version values and a missing version on adapter-author report drift", () => {
    expect(evaluate({ baseContractVersion: 0 }))
      .toMatchObject({ ok: false, reason: "invalid_adapter_author_contract_version" });
    expect(evaluate({
      changedPaths: [golden],
      labels: ["api-breaking"],
      baseContractVersion: null,
      headContractVersion: null,
    })).toMatchObject({ ok: false, reason: "adapter_author_contract_version_required" });
  });

  it("does not require an API label or review for unrelated internal changes", () => {
    expect(evaluate({
      changedPaths: ["src/daemon/agent-driver/src/adapters/claude/index.ts"],
      labels: [],
      reviews: [],
    })).toEqual({ ok: true, reason: "no_api_surface_change" });
  });

  it("protects the API report generation chain and trusted guard mechanism itself", () => {
    const mechanismPaths = [
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
    ];
    for (const path of mechanismPaths) {
      expect(evaluate({ changedPaths: [path], labels: [], reviews: [] }))
        .toMatchObject({ ok: false, reason: "current_head_independent_owner_approval_required" });
      expect(evaluate({ changedPaths: [path], labels: [], reviews: [ownerApproval] }))
        .toMatchObject({ ok: true, reason: "approved", changedApiPaths: [], changedMechanismPaths: [path] });
    }
  });

  it("still requires one API label when surface and mechanism paths change together", () => {
    expect(evaluate({
      changedPaths: [publicSource, "scripts/ci/api-surface-guard.mjs"],
      labels: [],
      reviews: [ownerApproval],
    })).toMatchObject({ ok: false, reason: "exactly_one_api_label_required" });
  });

  it("keeps approval enforcement base-owned and never executes pull-request head code", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/api-surface-guard.yml"), "utf8");
    const lfWorkflow = workflow.replaceAll("\r\n", "\n");
    for (const workflowSource of [lfWorkflow, lfWorkflow.replaceAll("\n", "\r\n")]) {
      const normalizedWorkflow = workflowSource.replaceAll("\r\n", "\n");
      expect(normalizedWorkflow).toContain("pull_request_target:");
      expect(normalizedWorkflow).toMatch(/pull_request_review:\n\s+types: \[submitted, dismissed\]/);
      expect(normalizedWorkflow).toContain("if: github.event.pull_request.base.ref == 'main'");
      expect(normalizedWorkflow).toContain("ref: ${{ github.event.pull_request.base.sha }}");
      expect(normalizedWorkflow).not.toContain("pnpm install");
      expect(normalizedWorkflow).not.toContain("pull request head");
      expect(normalizedWorkflow).not.toContain("if [[ ! -f");
    }
  });

  it("handles GitHub JSON success, not-found, and error responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response({}, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubJson("https://example.test/success", "token"))
      .resolves.toEqual({ ok: true });
    await expect(githubJson("https://example.test/missing", "token", true)).resolves.toBeNull();
    await expect(githubJson("https://example.test/error", "token"))
      .rejects.toThrow("GitHub API failed: 500");
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/success", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer token",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  });

  it("paginates GitHub resources and normalizes review identities", async () => {
    const firstPage = Array.from({ length: 100 }, (_, id) => ({ id }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(firstPage))
      .mockResolvedValueOnce(response([{ id: 100 }]))
      .mockResolvedValueOnce(response([
        { id: 1, user: { login: "owner" }, state: "APPROVED", commit_id: headSha },
        { id: 2, user: null, state: "COMMENTED", commit_id: headSha },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllPages("alookai/alook", "510", "files", "token"))
      .resolves.toHaveLength(101);
    await expect(fetchAllReviews("alookai/alook", "510", "token")).resolves.toEqual([{
      id: 1,
      login: "owner",
      state: "APPROVED",
      commitId: headSha,
    }]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/alookai/alook/pulls/510/files?per_page=100&page=1",
      "https://api.github.com/repos/alookai/alook/pulls/510/files?per_page=100&page=2",
      "https://api.github.com/repos/alookai/alook/pulls/510/reviews?per_page=100&page=1",
    ]);
  });

  it("reads contract versions from GitHub contents and treats absent files as unversioned", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response({ content: "not-used", encoding: "utf8" }))
      .mockResolvedValueOnce(response({ content: contractSource(3), encoding: "base64" })));

    await expect(contractVersionAt("alookai/alook", requiredCliEnv.API_BASE_SHA, "token"))
      .resolves.toBeNull();
    await expect(contractVersionAt("alookai/alook", requiredCliEnv.API_BASE_SHA, "token"))
      .resolves.toBeNull();
    await expect(contractVersionAt("alookai/alook", requiredCliEnv.API_HEAD_SHA, "token"))
      .resolves.toBe(3);
  });

  it("runs the real CLI orchestration against validated pull identity", async () => {
    stubCliEnv([{ name: "api-additive" }]);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pulls/510")) {
        return response({
          base: { sha: requiredCliEnv.API_BASE_SHA },
          head: { sha: requiredCliEnv.API_HEAD_SHA },
          user: { login: requiredCliEnv.API_PR_AUTHOR },
          changed_files: 1,
        });
      }
      if (url.includes("/files?")) return response([{ filename: publicSource }]);
      if (url.includes("/reviews?")) {
        return response([{
          id: 1,
          user: { login: "GenerQAQ" },
          state: "APPROVED",
          commit_id: requiredCliEnv.API_HEAD_SHA,
        }]);
      }
      if (url.includes(`/contents/${publicSource}?ref=${requiredCliEnv.API_BASE_SHA}`)) {
        return response({ content: contractSource(1), encoding: "base64" });
      }
      if (url.includes(`/contents/${publicSource}?ref=${requiredCliEnv.API_HEAD_SHA}`)) {
        return response({ content: contractSource(1), encoding: "base64" });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await main();

    expect(write).toHaveBeenCalledWith(expect.stringContaining('"reason":"approved"'));
    expect(process.exitCode).toBeUndefined();
  });

  it("fails the CLI closed for invalid invocation, identity drift, and rejected policy", async () => {
    stubCliEnv();
    delete process.env.API_GITHUB_TOKEN;
    await expect(main()).rejects.toThrow("Missing API_GITHUB_TOKEN");

    vi.stubEnv("API_GITHUB_TOKEN", requiredCliEnv.API_GITHUB_TOKEN);
    vi.stubEnv("API_BASE_SHA", "not-a-sha");
    await expect(main()).rejects.toThrow("Invalid base/head SHA");

    vi.stubEnv("API_BASE_SHA", requiredCliEnv.API_BASE_SHA);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      base: { sha: requiredCliEnv.API_BASE_SHA },
      head: { sha: requiredCliEnv.API_HEAD_SHA },
      user: { login: "different-author" },
      changed_files: 0,
    })));
    await expect(main()).rejects.toThrow("Pull request identity changed while evaluating API approval");

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pulls/510")) {
        return response({
          base: { sha: requiredCliEnv.API_BASE_SHA },
          head: { sha: requiredCliEnv.API_HEAD_SHA },
          user: { login: requiredCliEnv.API_PR_AUTHOR },
          changed_files: 1,
        });
      }
      if (url.includes("/files?")) return response([{ filename: "scripts/ci/api-surface-guard.mjs" }]);
      if (url.includes("/reviews?")) return response([]);
      if (url.includes("/contents/")) return response({}, 404);
      throw new Error(`Unexpected URL: ${url}`);
    }));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await main();

    expect(write).toHaveBeenCalledWith(expect.stringContaining(
      '"reason":"current_head_independent_owner_approval_required"',
    ));
    expect(process.exitCode).toBe(1);
  });
});
