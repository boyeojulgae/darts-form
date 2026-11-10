// Helpers for showing the stored camera frames. Each recorded frame keeps a JPEG still of the
// region around the thrower (`frame.img`) and the rectangle of the picture it covers (`frame.crop`).

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Square region around the head and throwing arm, in video pixels. */
export function armRegion(analysis, view, scale = 2.8, top = 0.36) {
  const L = analysis.forearmPx;
  const size = Math.min(scale * L, view.w, view.h);
  const x = clamp(analysis.face.x - size / 2, 0, view.w - size);
  const y = clamp(analysis.face.y - top * size, 0, view.h - size);
  return { x, y, size };
}

/** Decodes stored frames on demand and keeps only the most recent ones in memory. */
export class FrameCache {
  constructor(frames, max = 24) {
    this.frames = frames;
    this.max = max;
    this.map = new Map();
  }

  /** Nearest index around i that actually has a stored picture. */
  nearest(i) {
    const n = this.frames.length;
    for (let d = 0; d < 8; d++) {
      for (const j of [i - d, i + d]) if (j >= 0 && j < n && this.frames[j] && this.frames[j].img && this.frames[j].crop) return j;
    }
    return -1;
  }

  /** Returns { bmp, crop } if the picture is decoded, otherwise starts decoding and returns null. */
  get(i, onReady) {
    const j = this.nearest(i);
    if (j < 0) return null;
    const hit = this.map.get(j);
    if (hit) {
      if (!hit.bmp) return null;
      this.map.delete(j);
      this.map.set(j, hit);
      return hit;
    }
    const entry = { bmp: null, crop: this.frames[j].crop, closed: false };
    this.map.set(j, entry);
    createImageBitmap(this.frames[j].img).then((bmp) => {
      if (entry.closed) { bmp.close(); return; }
      entry.bmp = bmp;
      this.trim();
      if (onReady) onReady();
    }).catch(() => { this.map.delete(j); });
    return null;
  }

  trim() {
    while (this.map.size > this.max) {
      const [k, v] = this.map.entries().next().value;
      v.closed = true;
      if (v.bmp) v.bmp.close();
      this.map.delete(k);
    }
  }

  clear() {
    for (const v of this.map.values()) { v.closed = true; if (v.bmp) v.bmp.close(); }
    this.map.clear();
  }
}

/** Draw the region `sub` (video pixels) from a decoded picture onto the whole canvas. Returns false if nothing was drawn. */
export function drawRegion(ctx, pic, sub, alpha = 1) {
  if (!pic || !pic.bmp || pic.closed) return false;
  const { bmp, crop } = pic;
  const x0 = Math.max(sub.x, crop.x), y0 = Math.max(sub.y, crop.y);
  const x1 = Math.min(sub.x + sub.size, crop.x + crop.w), y1 = Math.min(sub.y + sub.size, crop.y + crop.h);
  if (x1 <= x0 || y1 <= y0) return false;
  const kx = bmp.width / crop.w, ky = bmp.height / crop.h;
  const s = ctx.canvas.width / sub.size;
  ctx.globalAlpha = alpha;
  ctx.drawImage(bmp, (x0 - crop.x) * kx, (y0 - crop.y) * ky, (x1 - x0) * kx, (y1 - y0) * ky, (x0 - sub.x) * s, (y0 - sub.y) * s, (x1 - x0) * s, (y1 - y0) * s);
  ctx.globalAlpha = 1;
  return true;
}

export const toCanvas = (sub, cv) => {
  const k = cv.width / sub.size;
  return { k, X: (x) => (x - sub.x) * k, Y: (y) => (y - sub.y) * k };
};
