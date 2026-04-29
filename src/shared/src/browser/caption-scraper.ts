export interface RawCaption {
  speaker: string
  text: string
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim()
}

export function parseCaptionElements(elements: { speakerHtml: string; textHtml: string }[]): RawCaption[] {
  const results: RawCaption[] = []

  for (const el of elements) {
    const speaker = stripHtml(el.speakerHtml)
    const text = stripHtml(el.textHtml)

    if (!speaker || !text) continue

    results.push({ speaker, text })
  }

  return results
}

export function buildCaptionObserverScript(): string {
  return `
    (() => {
      if (window.__alookCaptionObserver) return;

      window.__alookCaptions = [];
      window.__alookCaptionObserver = true;

      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            const el = node;
            // Caption overlays contain img (avatar) + text
            const imgs = el.querySelectorAll ? el.querySelectorAll('img') : [];
            if (imgs.length === 0 && !el.querySelector?.('img')) continue;

            const texts = [];
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let n;
            while (n = walker.nextNode()) {
              let inBtn = false;
              let p = n.parentElement;
              while (p && p !== el) {
                if (p.tagName === 'BUTTON') { inBtn = true; break; }
                p = p.parentElement;
              }
              if (inBtn) continue;
              const t = n.textContent.trim();
              if (t.length > 0 && t.length < 200) texts.push(t);
            }

            if (texts.length >= 2 && texts[0].length <= 40) {
              window.__alookCaptions.push({
                speakerHtml: texts[0],
                textHtml: texts.slice(1).join(' '),
                ts: Date.now(),
              });
            }
          }
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });
    })()
  `.trim()
}

export function buildCaptionScrapeScript(): string {
  return `
    (() => {
      const result = window.__alookCaptions || [];
      window.__alookCaptions = [];
      return result.map(c => ({ speakerHtml: c.speakerHtml, textHtml: c.textHtml }));
    })()
  `.trim()
}
