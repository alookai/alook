import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), ".lighthouseci");
const files = readdirSync(dir)
  .filter((f) => f.startsWith("lhr-") && f.endsWith(".json"))
  .sort();

if (files.length === 0) {
  console.log("No Lighthouse reports found.");
  process.exit(0);
}

const latest = JSON.parse(readFileSync(join(dir, files.at(-1)), "utf8"));
const cats = latest.categories || {};

console.log("\n┌─────────────────────────────────────┐");
console.log("│      Lighthouse Score Summary       │");
console.log("├─────────────────────────────────────┤");
for (const [, cat] of Object.entries(cats)) {
  const score = Math.round(cat.score * 100);
  const bar = score >= 90 ? "🟢" : score >= 50 ? "🟡" : "🔴";
  const name = cat.title.padEnd(20);
  console.log(`│  ${bar} ${name} ${String(score).padStart(3)}/100  │`);
}
console.log("└─────────────────────────────────────┘");

const audits = latest.audits || {};
const seoRefs = (cats.seo || {}).auditRefs || [];
const failed = seoRefs.filter((r) => {
  const a = audits[r.id];
  return a && a.score !== null && a.score < 1;
});

if (failed.length > 0) {
  console.log("\nSEO issues:");
  for (const ref of failed) {
    const a = audits[ref.id];
    console.log(`  ❌ ${a.title}`);
  }
}
