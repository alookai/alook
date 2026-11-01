import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)("jsdom") as { JSDOM: new (html: string) => { window: { document: Document } } };

export function validateStepGuide(html: string, guide: { slug: string; title: string }): string[] {
  const doc = new JSDOM(html).window.document;
  const errors: string[] = [];
  const check = (valid: unknown, message: string) => { if (!valid) errors.push(`/tutorials/${guide.slug}: ${message}`); };
  check(doc.querySelectorAll("h1").length === 1 && doc.querySelector("h1")?.textContent === guide.title, "expected one matching H1");
  check(doc.querySelector("title")?.textContent?.includes(guide.title), "missing title");
  check(doc.querySelector('meta[name="description"]')?.getAttribute("content"), "missing description");
  const canonicals = doc.querySelectorAll('link[rel="canonical"]');
  check(canonicals.length === 1 && canonicals[0].getAttribute("href") === `https://alook.ai/tutorials/${guide.slug}`, "invalid canonical");
  check(doc.querySelector('meta[property="og:image"]')?.getAttribute("content"), "missing social image");
  check(!doc.querySelector('meta[name="robots"]')?.getAttribute("content")?.includes("noindex"), "noindex");
  const article = doc.querySelector("[data-step-guide]");
  check(article && (article.textContent?.length ?? 0) > 400, "missing server-rendered guide body");
  check((article?.querySelectorAll("section[id] h2").length ?? 0) >= 4, "missing step headings");
  check(doc.querySelector('a[href="/c"]'), "missing CTA");
  check(doc.querySelector("footer"), "missing footer");
  // Inert UI replicas are illustrations, not document navigation or form controls.
  const ids = [...doc.querySelectorAll("[id]")].filter((node) => !node.closest("[inert]")).map((node) => node.id);
  check(ids.length === new Set(ids).size, "duplicate anchor");
  for (const link of doc.querySelectorAll('a[href^="#"]')) {
    if (link.closest("[inert]")) continue;
    check(doc.getElementById(link.getAttribute("href")!.slice(1)), "missing anchor target");
  }
  return errors;
}
