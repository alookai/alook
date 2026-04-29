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
      window.__alookCaptionObserver = true;
      window.__alookCaptions = [];
      window.__alookLastCaption = '';

      const observer = new MutationObserver(() => {
        // On any DOM change, scan for caption content.
        // Google Meet renders captions as overlays with img (avatar) + text.
        // The text mutates in-place (characterData), so we snapshot on every change.
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
          let entry = img.parentElement;
          // Walk up to find the caption entry container
          for (let i = 0; i < 4 && entry; i++) {
            const text = entry.textContent || '';
            if (text.length > 3 && entry.querySelectorAll('img').length === 1) break;
            entry = entry.parentElement;
          }
          if (!entry) continue;

          // Check this looks like a caption (has img + non-button text)
          const parts = [];
          const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            let inBtn = false;
            let p = node.parentElement;
            while (p && p !== entry) {
              if (p.tagName === 'BUTTON') { inBtn = true; break; }
              p = p.parentElement;
            }
            if (inBtn) continue;
            const t = node.textContent.trim();
            if (t.length > 0 && t.length < 500) parts.push(t);
          }

          if (parts.length < 2 || parts[0].length > 40) continue;

          const speaker = parts[0];
          const text = parts.slice(1).join(' ');
          const key = speaker + '::' + text;

          // Filter out UI elements misidentified as captions
          const lower = text.toLowerCase();
          if (lower.includes('background') || lower.includes('effects') || lower.includes('devices') ||
              lower.includes('more options') || lower.includes('still see your') ||
              lower.includes('settings') || lower.includes('reframe')) continue;

          // Only record if text changed from last snapshot
          if (key !== window.__alookLastCaption) {
            window.__alookLastCaption = key;
            window.__alookCaptions.push({
              speakerHtml: speaker,
              textHtml: text,
              ts: Date.now(),
            });
          }
        }
      });

      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
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
