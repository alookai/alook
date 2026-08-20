import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectChangedPaths,
  evaluateApiSurfaceGuard,
  parseAdapterAuthorContractVersion,
} from "./api-surface-guard.mjs";

const headSha = "b".repeat(40);
const publicSource = "src/daemon/agent-driver/src/adapter-author.ts";
const golden = "src/daemon/agent-driver/etc/api/adapter-author.api.md";
const ownerApproval = { id: 1, login: "independent-owner", state: "APPROVED", commitId: headSha };

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
    expect(evaluate()).toMatchObject({ ok: true, reason: "approved", approver: "independent-owner" });
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

  it("reads one canonical contract declaration as the first non-comment statement", () => {
    expect(parseAdapterAuthorContractVersion([
      "/** Adapter-author contract version. */",
      "export const ADAPTER_AUTHOR_CONTRACT_VERSION = 1 as const;",
      "export type Example = string;",
    ].join("\n"))).toBe(1);
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
  });

  it("does not require an API label or review for unrelated internal changes", () => {
    expect(evaluate({
      changedPaths: ["src/daemon/agent-driver/src/adapters/claude/index.ts"],
      labels: [],
      reviews: [],
    })).toEqual({ ok: true, reason: "no_api_surface_change" });
  });

  it("keeps approval enforcement base-owned and never executes pull-request head code", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/api-surface-guard.yml"), "utf8");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toMatch(/pull_request_review:\n\s+types: \[submitted, dismissed\]/);
    expect(workflow).toContain("if: github.event.pull_request.base.ref == 'main'");
    expect(workflow).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(workflow).not.toContain("pnpm install");
    expect(workflow).not.toContain("pull request head");
    expect(workflow).not.toContain("if [[ ! -f");
  });
});
