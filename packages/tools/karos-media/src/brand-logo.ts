/**
 * Fetches a client's brand logo for embedding into rendered slide templates.
 *
 * A separate downloader from `downloadImage` (the hero-image path),
 * deliberately: the hero downloader's `EXTENSION_BY_TYPE` refuses SVG and
 * must keep refusing it — an SVG in the photo-candidate pool would reach
 * contexts where it isn't a plain decoded image. A LOGO is different: it is
 * embedded as a data URI inside an `<img>` (an image-decoding context where
 * scripts never execute), and real client logos are very often SVG —
 * karosCMO's own upload route accepts them. Widening the hero whitelist to
 * accommodate logos would fix one path by weakening another.
 *
 * Returns `undefined` on ANY failure (bad status, unexpected content type,
 * over the size cap, network error): a logo is brand furniture, and brand
 * furniture must never be able to hold a run — the caller composes the
 * document without it and the slide ships.
 */

/** Logos are small; anything past this is not a logo, whatever it claims to be. Data URIs also count against the rendered document's size. */
export const BRAND_LOGO_MAX_BYTES = 1_500_000;

const LOGO_MIME_WHITELIST = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

export interface BrandLogoDownload {
  bytes: Uint8Array;
  /** The verified content type, parameter-stripped — safe to use in a data URI. */
  mime: string;
}

export async function downloadBrandLogo(
  fetchImpl: typeof fetch,
  url: string,
  maxBytes: number = BRAND_LOGO_MAX_BYTES,
): Promise<BrandLogoDownload | undefined> {
  if (!/^https:\/\//i.test(url)) return undefined;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return undefined;
    const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!LOGO_MIME_WHITELIST.has(mime)) return undefined;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) return undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());
    // The declared length is advisory; the actual byte count is the check
    // that holds.
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return undefined;
    return { bytes, mime };
  } catch {
    return undefined;
  }
}

/** The data-URI form the templates embed. Base64 never contains `{{`, so `fillTemplate`'s slot-stripping cannot touch it. */
export function brandLogoDataUri(download: BrandLogoDownload): string {
  return `data:${download.mime};base64,${Buffer.from(download.bytes).toString("base64")}`;
}
