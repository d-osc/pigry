/** Rasterises an SVG string to a PNG in the webview (canvas). Browser-only. */
export interface Raster { dataUrl: string; base64: string; width: number; height: number }

const MAX_SIDE = 3000;

export async function svgToPng(svg: string, width: number, height: number, scale = 1): Promise<Raster> {
  let k = scale;
  if (width * k > MAX_SIDE || height * k > MAX_SIDE) k = Math.min(MAX_SIDE / width, MAX_SIDE / height);
  const w = Math.max(1, Math.round(width * k)), h = Math.max(1, Math.round(height * k));
  const image = new window.Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('the design could not be rendered to an image'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas is unavailable');
  ctx.drawImage(image, 0, 0, w, h);
  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch {
    throw new Error('the design uses an external image that blocks PNG export — use data: URLs for images');
  }
  return { dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1), width: w, height: h };
}

/** Reads width/height from the standalone SVG produced by renderDesignSvg. */
export function svgSize(svg: string): { width: number; height: number } {
  const m = /<svg[^>]*\swidth="(\d+(?:\.\d+)?)"[^>]*\sheight="(\d+(?:\.\d+)?)"/.exec(svg);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 800, height: 600 };
}
