const MAX_SIZE = 200;

export type ThumbnailResult = { blob: Blob; width: number; height: number };

export async function generateThumbnail(file: File): Promise<ThumbnailResult | null> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") return null;

  let objectUrl: string | undefined;
  try {
    objectUrl = URL.createObjectURL(file);
    const img = await loadImage(objectUrl);
    const { w, h } = fitWithin(img.naturalWidth, img.naturalHeight, MAX_SIZE);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await canvasToBlob(canvas, "image/jpeg", 0.7);
    if (!blob) return null;
    return { blob, width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    return null;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function fitWithin(srcW: number, srcH: number, max: number) {
  if (srcW <= max && srcH <= max) return { w: srcW, h: srcH };
  const scale = Math.min(max / srcW, max / srcH);
  return { w: Math.round(srcW * scale), h: Math.round(srcH * scale) };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
