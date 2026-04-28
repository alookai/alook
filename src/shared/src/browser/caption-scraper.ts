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

export function buildCaptionScrapeScript(): string {
  return `
    (() => {
      const containers = document.querySelectorAll('[data-sender-name]');
      const result = [];
      for (const c of containers) {
        const speakerEl = c.querySelector('[data-sender-name]');
        const textEl = c.querySelector('[data-text]') || c.lastElementChild;
        if (speakerEl && textEl) {
          result.push({
            speakerHtml: speakerEl.getAttribute('data-sender-name') || speakerEl.textContent || '',
            textHtml: textEl.textContent || '',
          });
        }
      }

      if (result.length === 0) {
        const captions = document.querySelectorAll('.a4cQT');
        for (const cap of captions) {
          const nameEl = cap.querySelector('.zs7s8d');
          const textEl = cap.querySelector('.iTTPOb');
          if (nameEl && textEl) {
            result.push({
              speakerHtml: nameEl.textContent || '',
              textHtml: textEl.textContent || '',
            });
          }
        }
      }

      return result;
    })()
  `.trim()
}
