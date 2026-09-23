/**
 * WHERE A BRAND MARK BADGE SITS, CHOSEN BY LOOKING AT THE SLIDE (2026-09-23).
 *
 * The owner, twice in one evening: a logo does not have to take the whole
 * slide or sit in one of four fixed places; it can go at the side, and on some
 * pictures it belongs somewhere other than where it looks good on another.
 * A seeded choice cannot know that a face is in the top-left corner of THIS
 * photograph. The rendered page can.
 *
 * A template marks its badge `data-at="auto"`. Before the final screenshot the
 * renderer takes a quick one with the badge hidden, hands it back to the page
 * as a data URI (same-origin, so a canvas may read it; the slide's own
 * `file://` pictures would taint one), and tries each candidate placement:
 *
 * - REFUSED if the badge's box would touch any visible text (with a 14px
 *   margin), leave the canvas, or make the plate overflow. Copy never lands on
 *   a logo and a logo never lands on copy.
 * - Of the rest, the one over the QUIETEST pixels wins: mean luminance
 *   gradient under the badge's box and a margin around it, so a face, a
 *   product edge or a busy crowd costs more than sky, wall or ground.
 *
 * Ties (a flat typographic ground reads zero everywhere) go to the seeded
 * rotation, so posts still vary. Everything here is furniture: any failure
 * leaves the template's own default placement and never fails a render.
 */

/** Every placement the design system draws. Flow ones move the badge with `order`; the others are absolute, over the picture. */
export const MARK_AUTO_CANDIDATES = [
  "corner-top-end",
  "side-end",
  "corner-top-start",
  "side-start",
  "lead-start",
  "lead-end",
  "tail-end",
  "tail-start",
] as const;

/** The candidates, rotated by a seed so a tie does not always land in the same place. */
export function rotatedCandidates(seed: string): string[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  const offset = (h >>> 0) % MARK_AUTO_CANDIDATES.length;
  return [...MARK_AUTO_CANDIDATES.slice(offset), ...MARK_AUTO_CANDIDATES.slice(0, offset)];
}

/* eslint-disable @typescript-eslint/no-explicit-any -- runs in the browser page; this package has no DOM lib. */

/** In the page: is there an auto badge with a picture in it? Hides it for the measuring screenshot when so. */
export function prepareAutoMarkBadge(): boolean {
  const doc = (globalThis as any).document;
  const badge = doc.querySelector('.mark-badge[data-at="auto"]');
  if (badge === null) return false;
  const img = badge.querySelector("img");
  if (img === null || !img.getAttribute("src") || img.naturalWidth === 0) return false;
  badge.style.visibility = "hidden";
  return true;
}

/** In the page: try every candidate on the measuring screenshot and keep the best one. Returns what it chose, with each candidate's cost or refusal. */
export async function chooseMarkPlacementInPage(arg: { dataUri: string; candidates: string[]; w: number; h: number }): Promise<{ chosen: string; costs: Record<string, number | string> }> {
  const doc = (globalThis as any).document;
  const badge = doc.querySelector('.mark-badge[data-at="auto"]');
  const costs: Record<string, number | string> = {};
  if (badge === null) return { chosen: "", costs };
  // A FLOW placement: whatever else is refused, this one cannot overlap copy.
  const fallback = "lead-start";
  try {
    const image = new (globalThis as any).Image();
    image.src = arg.dataUri;
    await image.decode();
    const canvas = doc.createElement("canvas");
    canvas.width = arg.w;
    canvas.height = arg.h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, arg.w, arg.h);
    const pixels: Uint8ClampedArray = ctx.getImageData(0, 0, arg.w, arg.h).data;
    const lum = (x: number, y: number): number => {
      const i = (y * arg.w + x) * 4;
      return 0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]!;
    };
    // The classic YCbCr skin range (Cb 77-127, Cr 133-173), with a floor on
    // brightness so a dark brown ground is not read as a face.
    const isSkin = (x: number, y: number): boolean => {
      const i = (y * arg.w + x) * 4;
      const r = pixels[i]!;
      const g = pixels[i + 1]!;
      const b = pixels[i + 2]!;
      const yy = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      return yy > 60 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
    };
    const plate = doc.querySelector(".plate");
    const textRects = (): Array<{ left: number; top: number; right: number; bottom: number }> => {
      const out: Array<{ left: number; top: number; right: number; bottom: number }> = [];
      for (const el of doc.querySelectorAll("body *")) {
        if (badge.contains(el)) continue;
        const tag = String(el.tagName).toLowerCase();
        if (tag === "script" || tag === "style") continue;
        let hasText = false;
        for (const node of el.childNodes) if (node.nodeType === 3 && String(node.textContent).trim().length > 0) hasText = true;
        if (!hasText) continue;
        const style = (globalThis as any).getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      }
      return out;
    };
    let best = "";
    let bestCost = Number.POSITIVE_INFINITY;
    const margin = 14;
    for (const [index, candidate] of arg.candidates.entries()) {
      badge.setAttribute("data-at", candidate);
      const r = badge.getBoundingClientRect();
      if (r.width <= 0 || r.left < 0 || r.top < 0 || r.right > arg.w || r.bottom > arg.h) {
        costs[candidate] = "off-canvas";
        continue;
      }
      if (plate !== null && (plate.scrollHeight > plate.clientHeight + 1 || plate.scrollWidth > plate.clientWidth + 1)) {
        costs[candidate] = "overflows the plate";
        continue;
      }
      const hit = textRects().some((t) => !(t.right < r.left - margin || t.left > r.right + margin || t.bottom < r.top - margin || t.top > r.bottom + margin));
      if (hit) {
        costs[candidate] = "touches text";
        continue;
      }
      const x0 = Math.max(0, Math.floor(r.left - 16));
      const y0 = Math.max(0, Math.floor(r.top - 16));
      const x1 = Math.min(arg.w - 4, Math.ceil(r.right + 16));
      const y1 = Math.min(arg.h - 4, Math.ceil(r.bottom + 16));
      let sum = 0;
      let count = 0;
      let skin = 0;
      for (let y = y0; y < y1; y += 3) {
        for (let x = x0; x < x1; x += 3) {
          const here = lum(x, y);
          sum += Math.abs(lum(x + 3, y) - here) + Math.abs(lum(x, y + 3) - here);
          if (isSkin(x, y)) skin += 1;
          count += 1;
        }
      }
      // SKIN IS SMOOTH, SO A GRADIENT CALLS A FACE QUIET. The first render of
      // this put the Anthropic badge on the speaker's cheek. A face is the one
      // thing a badge must never cover, so every sampled skin-tone pixel costs
      // far more than any texture does.
      // The index is the seeded preference: it only decides between
      // placements whose pixels are within a hair of each other.
      const cost = (count > 0 ? sum / count + (skin / count) * 60 : 0) + index * 0.25;
      costs[candidate] = Math.round(cost * 100) / 100;
      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }
    badge.setAttribute("data-at", best !== "" ? best : fallback);
    badge.style.visibility = "";
    return { chosen: best !== "" ? best : fallback, costs };
  } catch (error) {
    badge.setAttribute("data-at", fallback);
    badge.style.visibility = "";
    costs["error"] = String(error).slice(0, 120);
    return { chosen: fallback, costs };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The Node half: measure, choose, and leave the page ready for its real screenshot. Never throws. */
export async function placeAutoMarkBadge(
  page: {
    evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
    screenshot(options: { type: "jpeg"; quality: number; scale: "css" }): Promise<Buffer>;
  },
  canvas: { w: number; h: number },
  seed: string,
): Promise<{ chosen: string; costs: Record<string, number | string> } | undefined> {
  try {
    const ready = await page.evaluate(prepareAutoMarkBadge as (arg: undefined) => boolean, undefined);
    if (!ready) return undefined;
    const shot = await page.screenshot({ type: "jpeg", quality: 70, scale: "css" });
    return await page.evaluate(chooseMarkPlacementInPage, { dataUri: `data:image/jpeg;base64,${shot.toString("base64")}`, candidates: rotatedCandidates(seed), w: canvas.w, h: canvas.h });
  } catch {
    return undefined;
  }
}
