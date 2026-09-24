import { assessReferenceFidelity, MIN_LABEL_WORDS_KEPT } from "@agent-engine/tool-karos-media";
import type { RenderCarouselInput } from "@agent-engine/tool-karos-publish";
import type { ImageSelection, InstagramCopyOutput, InstagramHookPattern } from "./types.js";

/**
 * ══ THE PRODUCT CAMPAIGN (stage 4 of the owner's reference-looks plan) ══
 *
 * Approved by the owner on 2026-09-24. The reference is a brand's own ad
 * campaign carousel: a picture-only set of SCENES built from the client's REAL
 * product — a hero shot, a label close-up, a billboard, a street poster, the
 * product in use, a flat-lay. Every scene is a generation that receives the
 * client's actual product photograph as a REFERENCE image (`image.generate`
 * 2.3.0 `references`), so the product stays the client's product.
 *
 * It is the one approved exception to the standing "no whole-slide images"
 * rule: in this mode every slide is a full-bleed picture and nothing else.
 *
 * ## Everything here is pure and free
 *
 * The workflow owns the calls (`04q-plan-product-campaign`, the `05pc-*`
 * steps, `08pc-render-campaign`); this module owns the decisions, so every
 * one of them is testable without a model, a bucket or a browser:
 *
 * - which of the client's pictures is the product photo (`productPhotoCandidates`,
 *   `pickProductPhoto`) — a vision model reads, code decides;
 * - what the product is called and which short line a billboard may carry
 *   (`campaignProductName`, `inImageCopyFor`) — the client's own words only,
 *   never invented copy;
 * - how many scenes the run's generation budget allows and which ones
 *   (`campaignSceneCount`, `planCampaignScenes`) — fewer scenes, never a
 *   failed run;
 * - whether a generated frame may ship (`checkInImageText`,
 *   `judgeCampaignFrame`) — the words on it are compared LETTER BY LETTER
 *   with the words it was asked for, and a frame that misspells them never
 *   ships.
 *
 * ## Never on by default
 *
 * Only a run that asks (`requestedMode: "product_campaign"`), a client whose
 * config lists it (`instagramPostModes`) or whose learned preference does, and
 * only when a real product photo is on hand. Anything else runs the normal
 * carousel and records why (owner rules: agents always deliver; never hold on
 * an internal gate; budgets adapt, never hold).
 */

/** The `requestedMode` / `instagramPostModes` value that asks for this mode. */
export const PRODUCT_CAMPAIGN_MODE = "product_campaign" as const;

/** Fewer than this many verified scenes is not a campaign: the run falls back to the normal carousel. */
export const CAMPAIGN_MIN_SCENES = 3;
/** The reference carousel's six scenes. */
export const CAMPAIGN_MAX_SCENES = 6;
/**
 * Generation rounds per campaign: the first draws every scene, the second
 * redraws only the frames that failed their read-back. Past that a failing
 * frame is DROPPED — a misspelled billboard is never the answer.
 */
export const CAMPAIGN_MAX_ROUNDS = 2;
/** How many of the client's pictures one vision call looks at to find the product photo. */
export const PRODUCT_PHOTO_INSPECT_LIMIT = 4;
/** A picture from the client's library must score this on the "is this a product photo" brief. */
export const MIN_LIBRARY_PRODUCT_FIT = 4;
/** A picture the client uploaded FOR THIS RUN is their instruction, so the bar is only "not clearly something else". */
export const MIN_UPLOAD_PRODUCT_FIT = 3;
/** A generated scene must show the reference product recognisably (the vision model's `fitScore` against the scene brief). */
export const MIN_SCENE_FIT = 3;
/** In-image copy is a short line. Past this an image model's spelling falls apart, and the tool refuses 60+. */
export const MAX_IN_IMAGE_COPY_CHARS = 40;
export const MAX_IN_IMAGE_COPY_WORDS = 6;
/** The one template file every campaign slide renders through. */
export const CAMPAIGN_PLATE_FILE = "campaign.html";

// ─────────────────────────────────────────────────────────────────────────
// The product photo
// ─────────────────────────────────────────────────────────────────────────

export type ProductPhotoOrigin = "client-upload" | "client-site" | "client-library";

/** One of the client's own pictures, as the run already holds it. */
export interface ProductPhotoCandidate {
  path: string;
  origin: ProductPhotoOrigin;
  /** The description the run holds (upload vision text, or the library's stored sentence). */
  description: string;
  /** The client's own name for what is in it: an upload's label, a site page's caption or title. */
  productName?: string;
  /** Ordering only — see `productShotScore`. */
  score: number;
}

const PRODUCT_WORDS =
  /\b(product|packag\w*|bottle|jar|can|box|tube|pouch|sachet|label|carton|packshot|perfume|shoe|sneaker|garment|dress|shirt|jacket|lingerie|thong|bra|watch|device|gadget|mug|candle|cosmetic|serum|cream|lotion|bag|backpack|chocolate|bar)\b/iu;
const STUDIO_WORDS = /\b(white background|plain background|plain backdrop|seamless|studio|isolated|on a table|close-up|packshot)\b/iu;
const NOT_A_PRODUCT_WORDS = /\b(screenshot|website|web page|logo|chart|diagram|infographic|team|office|crowd|group of|banner|text overlay|headshot)\b/iu;

/**
 * How much a stored sentence READS like a product shot. **Ordering only**: it
 * decides which few of the client's pictures the vision call looks at, never
 * whether one is accepted. A phrase matcher is a note, not a verdict — the
 * vision model's `fitScore` on the product brief is what accepts a picture.
 */
export function productShotScore(description: string): number {
  let score = 0;
  if (PRODUCT_WORDS.test(description)) score += 2;
  if (STUDIO_WORDS.test(description)) score += 1;
  if (NOT_A_PRODUCT_WORDS.test(description)) score -= 2;
  return score;
}

/** The first segment of a page title: "Original Rise Thong | Hanky Panky" is the product, not the shop. */
function titleProduct(title: string): string {
  return title.split(/\s+[|–—-]\s+|\s*\|\s*/u)[0]!.trim();
}

/** The client's own name for a library frame: the site's caption, else the page title's first segment. */
export function productNameFromDescription(description: string): string | undefined {
  const caption = /captions it "([^"]+)"/u.exec(description)?.[1]?.trim();
  if (caption !== undefined && caption.length > 0) return caption;
  const title = /on the page "([^"]+)"/u.exec(description)?.[1];
  const fromTitle = title === undefined ? undefined : titleProduct(title);
  return fromTitle !== undefined && fromTitle.length > 0 ? fromTitle : undefined;
}

/**
 * The client's own pictures that could be THE product photo, in the order
 * they should be looked at.
 *
 * Uploads for this run come first, in upload order: a person who asked for a
 * campaign and attached a picture has said which product. Then library
 * frames, and only the client's OWN — a picture from its website or an
 * earlier upload. A third-party frame in the library is never a reference:
 * placing someone else's photograph of a product into generated scenes is not
 * the client's product and not the client's rights.
 */
export function productPhotoCandidates(
  uploads: ReadonlyArray<{ path: string; description: string; label?: string | undefined }>,
  library: ReadonlyArray<{ path: string; description: string }>,
): ProductPhotoCandidate[] {
  const fromUploads: ProductPhotoCandidate[] = uploads.map((u) => ({
    path: u.path,
    origin: "client-upload",
    description: u.description,
    ...(u.label !== undefined && u.label.trim().length > 0 ? { productName: u.label.trim() } : {}),
    score: productShotScore(u.description),
  }));
  const fromLibrary: ProductPhotoCandidate[] = library.flatMap((l) => {
    const origin: ProductPhotoOrigin | undefined = l.description.includes("publishes this image on its own website")
      ? "client-site"
      : l.description.includes("The client owns this image")
        ? "client-library"
        : undefined;
    if (origin === undefined) return [];
    const productName = productNameFromDescription(l.description);
    return [{ path: l.path, origin, description: l.description, ...(productName !== undefined ? { productName } : {}), score: productShotScore(l.description) }];
  });
  // Stable: equal scores keep the library's own order (uploads before site frames, newest first).
  const rankedLibrary = fromLibrary.map((c, i) => ({ c, i })).sort((a, b) => b.c.score - a.c.score || a.i - b.i).map((x) => x.c);
  return [...fromUploads, ...rankedLibrary];
}

/** What `media.inspectImages` read on one picture, narrowed to what these decisions use. */
export interface VisionReading {
  description?: string;
  textInImage: string[];
  fitScore?: number;
  fitReason?: string;
  quality?: string;
  hasWatermark?: boolean;
  looksLikeScreenshot?: boolean;
}

/** Normalises one `inspections[]` row into a `VisionReading`, defensively: a field of the wrong type is simply absent. */
export function visionReadingOf(raw: Record<string, unknown>): VisionReading {
  return {
    ...(typeof raw["description"] === "string" ? { description: raw["description"] } : {}),
    textInImage: Array.isArray(raw["textInImage"]) ? (raw["textInImage"] as unknown[]).filter((t): t is string => typeof t === "string") : [],
    ...(typeof raw["fitScore"] === "number" ? { fitScore: raw["fitScore"] } : {}),
    ...(typeof raw["fitReason"] === "string" ? { fitReason: raw["fitReason"] } : {}),
    ...(typeof raw["quality"] === "string" ? { quality: raw["quality"] } : {}),
    ...(typeof raw["hasWatermark"] === "boolean" ? { hasWatermark: raw["hasWatermark"] } : {}),
    ...(typeof raw["looksLikeScreenshot"] === "boolean" ? { looksLikeScreenshot: raw["looksLikeScreenshot"] } : {}),
  };
}

/** The brief the product photo is judged against. */
export const PRODUCT_PHOTO_BRIEF =
  "A clear photograph of ONE product this business sells: the product itself (its packaging, bottle, garment, device or object) is the main subject, sharp and fully in frame, usable as a reference for placing that exact product in new scenes. A picture where the product is small or absent, where a person or a place is the subject, a logo, a screenshot or a banner does not fit.";

export interface ProductPhotoChoice {
  chosen?: { candidate: ProductPhotoCandidate; reading: VisionReading };
  considered: Array<{ path: string; origin: ProductPhotoOrigin; fitScore?: number; verdict: string }>;
}

/**
 * Chooses the product photo from what the vision model read. The highest
 * `fitScore` that clears its origin's bar wins; a tie goes to the earlier
 * candidate (an upload before a library frame). Unusable, watermarked and
 * screenshot frames are refused whatever they scored.
 */
export function pickProductPhoto(candidates: readonly ProductPhotoCandidate[], readings: ReadonlyMap<string, VisionReading>): ProductPhotoChoice {
  const considered: ProductPhotoChoice["considered"] = [];
  let best: { candidate: ProductPhotoCandidate; reading: VisionReading; fit: number } | undefined;
  for (const candidate of candidates) {
    const reading = readings.get(candidate.path);
    if (reading === undefined) {
      considered.push({ path: candidate.path, origin: candidate.origin, verdict: "not read by the vision pass" });
      continue;
    }
    const fit = reading.fitScore;
    const row = { path: candidate.path, origin: candidate.origin, ...(fit !== undefined ? { fitScore: fit } : {}) };
    if (reading.quality === "unusable" || reading.hasWatermark === true || reading.looksLikeScreenshot === true) {
      considered.push({ ...row, verdict: "refused: unusable, watermarked or a screenshot" });
      continue;
    }
    const bar = candidate.origin === "client-upload" ? MIN_UPLOAD_PRODUCT_FIT : MIN_LIBRARY_PRODUCT_FIT;
    if (fit === undefined || fit < bar) {
      considered.push({ ...row, verdict: `not a product photo (fit ${fit ?? "unscored"} against a bar of ${bar}${reading.fitReason ? `: ${reading.fitReason}` : ""})` });
      continue;
    }
    considered.push({ ...row, verdict: `eligible (fit ${fit})` });
    if (best === undefined || fit > best.fit) best = { candidate, reading, fit };
  }
  return best === undefined ? { considered } : { chosen: { candidate: best.candidate, reading: best.reading }, considered };
}

// ─────────────────────────────────────────────────────────────────────────
// Names and in-image copy — the client's own words, never invented
// ─────────────────────────────────────────────────────────────────────────

function clean(text: string | undefined): string | undefined {
  const out = text?.replace(/\s+/gu, " ").trim();
  return out === undefined || out.length === 0 ? undefined : out;
}

/**
 * What the product is called, in precedence order: the client config's
 * override, the product photo's own name (the upload's label, the site's
 * caption), the brief's first offer, a product the brief lists as the
 * client's own asset. `undefined` when none of them says — a scene then names
 * "the client's product" and carries no product-name lettering.
 */
export function campaignProductName(params: {
  override?: string | undefined;
  fromPhoto?: string | undefined;
  offers?: ReadonlyArray<{ name: string }>;
  ownAssets?: ReadonlyArray<{ title: string; kind: string }>;
}): string | undefined {
  return (
    clean(params.override) ??
    clean(params.fromPhoto) ??
    clean(params.offers?.[0]?.name) ??
    clean(params.ownAssets?.find((a) => a.kind === "product")?.title)
  );
}

const LATIN_COPY = /^[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N} '’&.,-]*$/u;

/**
 * The line a billboard or a poster may carry, or `undefined` when this text
 * should not be lettered at all.
 *
 * Short (at most six words, forty characters), in Latin script (image models
 * letter other scripts unreliably, and a Hebrew slogan that comes back as
 * shapes is a dropped frame paid for), with its trailing punctuation removed
 * (a read-back that loses a full stop is not a misspelling worth a frame).
 */
export function inImageCopyFor(text: string | undefined): string | undefined {
  const base = clean(text)?.replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "").replace(/[.!?,;:]+$/u, "").trim();
  if (base === undefined || base.length === 0) return undefined;
  if (base.length > MAX_IN_IMAGE_COPY_CHARS) return undefined;
  if (base.split(" ").length > MAX_IN_IMAGE_COPY_WORDS) return undefined;
  if (!LATIN_COPY.test(base)) return undefined;
  if ((base.match(/\p{L}/gu) ?? []).length < 2) return undefined;
  return base;
}

// ─────────────────────────────────────────────────────────────────────────
// The scene plan — deterministic, no prompt
// ─────────────────────────────────────────────────────────────────────────

export type CampaignSceneId = "hero" | "detail" | "billboard" | "lifestyle" | "street-poster" | "flat-lay";

export interface CampaignScene {
  /** Slide number, 1-based, in display order. */
  n: number;
  id: CampaignSceneId;
  label: string;
  /** The generation brief (`image.generate`'s `prompt`). */
  prompt: string;
  /** The exact words the frame must carry, when this scene carries any. */
  lettering?: string;
  /** `label`: the product's own label must read back (hero). `presence`: the product must be recognisable; its small print may be too small to read. */
  fidelity: "label" | "presence";
}

/** Which scenes a smaller budget keeps, most important first. */
const SCENE_PRIORITY: readonly CampaignSceneId[] = ["hero", "billboard", "lifestyle", "detail", "flat-lay", "street-poster"];
/** The order the kept scenes are shown in: the reference campaign's sequence. */
const SCENE_DISPLAY_ORDER: readonly CampaignSceneId[] = ["hero", "detail", "billboard", "lifestyle", "street-poster", "flat-lay"];

const SCENE_LABELS: Record<CampaignSceneId, string> = {
  hero: "hero shot",
  detail: "detail close-up",
  billboard: "billboard",
  lifestyle: "in use",
  "street-poster": "street poster",
  "flat-lay": "flat-lay",
};

/**
 * How many scenes this run can afford. The budget is the run's remaining
 * generated-image allowance; two of it are kept for redrawing frames that
 * fail their read-back, and the plan never goes above six or below three.
 * With less than three left the answer is three and there is no redraw:
 * `MIN_GENERATED_IMAGES_PER_RUN` guarantees a run three.
 */
export function campaignSceneCount(remainingImages: number): number {
  const budget = Number.isFinite(remainingImages) ? Math.floor(remainingImages) : 0;
  return Math.min(CAMPAIGN_MAX_SCENES, Math.max(CAMPAIGN_MIN_SCENES, budget - 2));
}

/**
 * The campaign's scenes, in display order, numbered 1..count.
 *
 * The billboard carries the client's slogan (else the product name) and the
 * street poster the product name (else the company name) — each only when it
 * passes `inImageCopyFor`. Every other scene carries no words beyond what is
 * printed on the product itself.
 */
export function planCampaignScenes(params: {
  count: number;
  productName?: string | undefined;
  slogan?: string | undefined;
  companyName?: string | undefined;
  audience?: string | undefined;
}): CampaignScene[] {
  const count = Math.min(CAMPAIGN_MAX_SCENES, Math.max(1, Math.floor(params.count)));
  const keep = new Set(SCENE_PRIORITY.slice(0, count));
  const product = `the client's product${params.productName !== undefined ? `, ${params.productName}` : ""} (the reference image)`;
  const productCopy = inImageCopyFor(params.productName);
  const billboardCopy = inImageCopyFor(params.slogan) ?? productCopy;
  const posterCopy = productCopy ?? inImageCopyFor(params.companyName);
  const audience = clean(params.audience)?.slice(0, 120);

  const build = (id: CampaignSceneId): Omit<CampaignScene, "n"> => {
    switch (id) {
      case "hero":
        return {
          id,
          label: SCENE_LABELS[id],
          prompt: `A premium advertising-campaign hero shot of ${product}: the product alone, centred and filling most of the frame, on a seamless studio backdrop in a colour from the brand palette, with soft sculpted light and a gentle reflection beneath it.`,
          fidelity: "label",
        };
      case "detail":
        return {
          id,
          label: SCENE_LABELS[id],
          prompt: `An extreme macro close-up of ${product}, filling the frame with its most distinctive detail (its label, texture, stitching or finish) in razor-sharp focus against a softly blurred background.`,
          fidelity: "presence",
        };
      case "billboard":
        return {
          id,
          label: SCENE_LABELS[id],
          prompt: `${capitalise(product)} advertised on a large roadside billboard in a city at golden hour, photographed from street level as real outdoor-advertising photography; the billboard shows the product large${billboardCopy !== undefined ? " beside the campaign line" : " on a clean brand-coloured ground"}.`,
          ...(billboardCopy !== undefined ? { lettering: billboardCopy } : {}),
          fidelity: "presence",
        };
      case "lifestyle":
        return {
          id,
          label: SCENE_LABELS[id],
          prompt: `${capitalise(product)} in use in a candid, everyday moment${audience !== undefined ? ` that fits the brand's audience (${audience})` : ""}, in natural light; the product is clearly visible and is the hero of the frame. No identifiable real person.`,
          fidelity: "presence",
        };
      case "street-poster":
        return {
          id,
          label: SCENE_LABELS[id],
          prompt: `A paste-up campaign poster for ${product} on a city wall beside a pavement, slightly weathered paper, photographed as real street photography; the poster shows the product large${posterCopy !== undefined ? " with the campaign words" : ""}.`,
          ...(posterCopy !== undefined ? { lettering: posterCopy } : {}),
          fidelity: "presence",
        };
      case "flat-lay":
        return {
          id,
          label: SCENE_LABELS[id],
          prompt: `A top-down flat-lay of ${product} arranged with a few complementary objects on a textured surface in brand-palette tones, a clean composition with generous space around the product.`,
          fidelity: "presence",
        };
    }
  };

  return SCENE_DISPLAY_ORDER.filter((id) => keep.has(id)).map((id, index) => ({ n: index + 1, ...build(id) }));
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/**
 * The brief for a redraw of a frame that failed its read-back: the same scene,
 * plus the one sentence naming what went wrong, so the second draw is not a
 * blind resample of the first.
 */
export function redrawPrompt(scene: CampaignScene, failure: string): string {
  return `${scene.prompt} The previous attempt was refused because ${failure.replace(/\.$/u, "")}; correct exactly that.`;
}

// ─────────────────────────────────────────────────────────────────────────
// The read-back: LETTER BY LETTER
// ─────────────────────────────────────────────────────────────────────────

/**
 * Case and whitespace, and nothing else that can change a letter: typographic
 * apostrophes and quotes are folded to their plain forms (the same character
 * to a reader), NFKC folds ligatures and full-width forms. A letter that is
 * wrong, missing or extra still differs after this.
 */
export function normaliseLettering(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’ʼ`´]/gu, "'")
    .replace(/[“”]/gu, '"')
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

export interface InImageTextCheck {
  ok: boolean;
  /** What the frame was asked to carry. */
  intended: string;
  /** What the vision pass read on the frame, joined. */
  read: string;
  reason: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Does the frame carry EXACTLY the words it was asked for?
 *
 * The intended line must occur in what the vision pass transcribed, as a
 * whole run of words (a letter touching either end fails: "Laces" is not
 * "Lace"), after `normaliseLettering` and nothing more. One wrong, missing or
 * extra letter fails; so does an empty read. The OCR's own line breaks are
 * joined with a space, so a slogan set on two lines still reads as one.
 *
 * What this does NOT judge: words elsewhere in the frame. `judgeCampaignFrame`
 * holds every OTHER word to the product's own label, so a correctly spelled
 * slogan beside a misspelled copy of itself still fails there.
 */
export function checkInImageText(intended: string, textInImage: readonly string[]): InImageTextCheck {
  const want = normaliseLettering(intended);
  const readRaw = textInImage.map((t) => t.replace(/\s+/gu, " ").trim()).filter((t) => t.length > 0).join(" ");
  const read = normaliseLettering(readRaw);
  if (want.length === 0) return { ok: true, intended, read: readRaw, reason: "no lettering was asked for" };
  if (read.length === 0) return { ok: false, intended, read: readRaw, reason: `the frame carries no legible words, and it must carry "${intended}"` };
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(want).replace(/ /gu, "\\s+")}(?![\\p{L}\\p{N}])`, "u");
  return pattern.test(read)
    ? { ok: true, intended, read: readRaw, reason: `the frame carries "${intended}" letter for letter` }
    : { ok: false, intended, read: readRaw, reason: `the lettering reads "${readRaw}", not "${intended}" letter for letter` };
}

/** Lower-cased 3+-letter words, the same tokenisation `assessReferenceFidelity` uses. */
function fidelityWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u)) {
    if ((raw.match(/\p{L}/gu) ?? []).length >= 3) out.add(raw);
  }
  return out;
}

export interface CampaignFrameVerdict {
  ok: boolean;
  /** Every reason the frame was refused. Empty when it passed. */
  reasons: string[];
  lettering?: InImageTextCheck;
  fidelity?: { kept: number; missing: string[]; invented: string[] };
  fitScore?: number;
}

/**
 * May this generated frame ship? Every check must pass, and an unread frame
 * never does (unverified lettering is not shipped):
 *
 * 1. It is usable and unwatermarked.
 * 2. The reference product is recognisably in it (`fitScore` against the
 *    scene brief, at least `MIN_SCENE_FIT`).
 * 3. Asked-for lettering reads back letter for letter (`checkInImageText`).
 * 4. Every OTHER legible word is on the product's own label
 *    (`assessReferenceFidelity`'s `invented`, minus the asked-for words): a
 *    re-lettered label, a stray slogan or a misspelled duplicate fails.
 * 5. On a `label` scene (the hero) the label survives: at least
 *    `MIN_LABEL_WORDS_KEPT` of its words read back.
 */
export function judgeCampaignFrame(scene: Pick<CampaignScene, "lettering" | "fidelity">, referenceText: readonly string[], reading: VisionReading | undefined): CampaignFrameVerdict {
  if (reading === undefined) return { ok: false, reasons: ["the frame could not be read back, so its lettering and its product are unverified"] };
  const reasons: string[] = [];
  if (reading.quality === "unusable") reasons.push(`the frame is unusable${reading.description ? ` (${reading.description})` : ""}`);
  if (reading.hasWatermark === true) reasons.push("the frame carries a watermark");
  if (reading.fitScore === undefined) reasons.push("the vision pass did not score whether the product is in the frame");
  else if (reading.fitScore < MIN_SCENE_FIT) reasons.push(`the product is not recognisably the client's (fit ${reading.fitScore}${reading.fitReason ? `: ${reading.fitReason}` : ""})`);

  let lettering: InImageTextCheck | undefined;
  if (scene.lettering !== undefined) {
    lettering = checkInImageText(scene.lettering, reading.textInImage);
    if (!lettering.ok) reasons.push(lettering.reason);
  }

  const fidelity = assessReferenceFidelity(referenceText, reading.textInImage);
  const allowed = fidelityWords(scene.lettering ?? "");
  const invented = fidelity.invented.filter((w) => !allowed.has(w));
  if (invented.length > 0) reasons.push(`words appear that are on neither the product's label nor the campaign line: ${invented.join(", ")}`);
  if (scene.fidelity === "label" && fidelity.missing.length > 0 && fidelity.kept < MIN_LABEL_WORDS_KEPT) {
    reasons.push(`the product's label did not survive (only ${Math.round(fidelity.kept * 100)}% of its words read back; missing: ${fidelity.missing.join(", ")})`);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    ...(lettering !== undefined ? { lettering } : {}),
    fidelity: { kept: fidelity.kept, missing: fidelity.missing, invented },
    ...(reading.fitScore !== undefined ? { fitScore: reading.fitScore } : {}),
  };
}

/** The brief every generated scene is read against, so `fitScore` answers "is the reference product in this frame". */
export function sceneCheckBrief(productName: string | undefined): string {
  return `An advertising scene that must show the client's own product${productName !== undefined ? `, ${productName}` : ""}, recognisably THE SAME product as the image with ref "product" (same shape, colours and label). Score fitScore on whether that exact product is clearly present and faithful; the setting does not matter. Transcribe every legible word exactly as printed, letter for letter, without correcting spelling.`;
}

// ─────────────────────────────────────────────────────────────────────────
// The deliverable
// ─────────────────────────────────────────────────────────────────────────

/** One scene that passed every check, with the file that ships. */
export interface CampaignFrame {
  scene: CampaignScene;
  path: string;
  fitScore?: number;
  fitReason?: string;
  round: number;
}

/**
 * The campaign plate: the scene, full bleed, and nothing else. No headline,
 * no scrim, no furniture — the approved exception to the no-whole-slide-image
 * rule is exactly this. Written by code at render time (not a synced plate of
 * the design system), sized to whatever viewport the renderer sets, and it
 * raises the renderer's ready flag once the picture has decoded.
 */
export function campaignPlateHtml(): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    "<title>instagram-agent product campaign plate</title>",
    "<style>",
    "*, *::before, *::after { box-sizing: border-box; }",
    "html, body { margin: 0; padding: 0; background: #000; }",
    "body { inline-size: 100vw; block-size: 100vh; overflow: hidden; }",
    ".campaign-scene { display: block; inline-size: 100vw; block-size: 100vh; object-fit: cover; }",
    "</style>",
    "</head>",
    "<body>",
    '<img class="campaign-scene" src="{{image:hero}}" alt="" />',
    "<script>",
    "(function () {",
    "  var img = document.querySelector('.campaign-scene');",
    "  var done = function () { window.__CAROUSEL_READY__ = true; };",
    "  if (!img || img.complete) { done(); return; }",
    "  img.addEventListener('load', done);",
    "  img.addEventListener('error', done);",
    "})();",
    "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** The run-scoped directory the plate is written to (repo-relative), beside the materialised templates. */
export function campaignPlateDir(runId: string): string {
  return `.template-cache/${runId}/product-campaign`;
}

export function buildCampaignSlidesData(params: {
  clientSlug: string;
  postId: string;
  repoRoot: string;
  runId: string;
  canvas: RenderCarouselInput["canvas"];
  frames: readonly CampaignFrame[];
}): RenderCarouselInput {
  return {
    client: params.clientSlug,
    postId: params.postId,
    templateDir: campaignPlateDir(params.runId),
    // The same deterministic output directory `assembleSlidesData` uses, so a
    // campaign lands where every other carousel of this post would.
    outDir: `instagram-output/${params.clientSlug}/${params.postId}`,
    repoRoot: params.repoRoot,
    slides: params.frames.map((frame, index) => ({
      n: index + 1,
      template: CAMPAIGN_PLATE_FILE,
      // Not rendered (the plate has no text slot); carried so the topic
      // guardrail, the reviewer's payload and the deliverable all see the
      // words that ARE in the picture.
      fields: { sceneLabel: frame.scene.label, ...(frame.scene.lettering !== undefined ? { lettering: frame.scene.lettering } : {}) },
      images: { hero: frame.path },
      htmlFragments: {},
    })),
    canvas: params.canvas,
    readyFlag: "__CAROUSEL_READY__",
  };
}

/** What a generated scene's licence line says: generated, and built on the client's own photograph. */
export function campaignLicence(origin: ProductPhotoOrigin): string {
  const photo = origin === "client-upload" ? "a photo the client uploaded" : origin === "client-site" ? "a photo from the client's own website" : "a photo the client supplied for an earlier post";
  return `Generated image, no third-party rights: created for this post, owned outright, unwatermarked, no attribution required; its product is the client's own, from ${photo}, used as the generation reference`;
}

export function buildCampaignSelections(frames: readonly CampaignFrame[], origin: ProductPhotoOrigin): ImageSelection[] {
  return frames.map((frame, index) => {
    const fit = Math.min(5, Math.max(MIN_SCENE_FIT, Math.round(frame.fitScore ?? MIN_SCENE_FIT)));
    const why = frame.fitReason ?? `the client's product is recognisably in the ${frame.scene.label} scene`;
    return {
      n: index + 1,
      imagePath: frame.path,
      reason:
        `product campaign scene "${frame.scene.label}", generated from the client's own product photo as a reference; ` +
        (frame.scene.lettering !== undefined ? `its lettering read back letter for letter ("${frame.scene.lettering}")` : "no words beyond the product's own label") +
        `; product check ${fit}/5`,
      license: campaignLicence(origin),
      rightsUsable: true,
      watermarkFree: true,
      claimMatch: fit,
      claimMatchReason: why,
      subjectMatch: fit,
      subjectMatchReason: why,
      licenceClass: "blanket",
    };
  });
}

/**
 * The copy object the rest of the run carries for a campaign: one `photo`
 * slide per scene (the headline and body describe the picture, which is what
 * the packager writes alt text from; nothing of them is rendered) and the
 * caption the writer produced.
 */
export function buildCampaignCopy(params: {
  frames: readonly CampaignFrame[];
  caption: string;
  productName?: string | undefined;
  sourceRef: string;
  hookPattern?: InstagramHookPattern | undefined;
}): InstagramCopyOutput {
  return {
    format: "carousel",
    ...(params.hookPattern !== undefined ? { hookPattern: params.hookPattern } : {}),
    slides: params.frames.map((frame, index) => ({
      n: index + 1,
      headline: (params.productName !== undefined ? `${params.productName}: ${frame.scene.label}` : `Product campaign: ${frame.scene.label}`).slice(0, 200),
      body: (frame.scene.lettering !== undefined
        ? `A ${frame.scene.label} scene of the client's own product carrying the words "${frame.scene.lettering}".`
        : `A ${frame.scene.label} scene of the client's own product.`
      ).slice(0, 600),
      visualNeed: frame.scene.prompt,
      sourceRef: params.sourceRef.slice(0, 300),
      layout: "photo" as const,
    })),
    caption: params.caption.slice(0, 2200),
  };
}

/**
 * The instruction the writer drafts the campaign's caption under, carried on
 * the copy step's existing `runDirection` field (no prompt change): the post
 * is the client's product campaign, the slides are pictures, and the caption
 * carries the words.
 */
export function campaignCaptionDirection(params: { productName?: string | undefined; sceneLabels: readonly string[]; personDirection?: string | undefined }): string {
  const product = params.productName ?? "the client's own product";
  return [
    ...(params.personDirection !== undefined ? [params.personDirection] : []),
    `PRODUCT CAMPAIGN: this post is a picture-only campaign carousel for ${product} (${params.sceneLabels.join(", ")}). ` +
      "The slides are photographs of the product and carry no headline, so the CAPTION carries the words: present the product, " +
      `say what makes ${product} worth having, and close with a specific invitation. Draw on the facts only where they genuinely bear on the product, and never invent a claim, a price or a number about it.`,
  ].join("\n\n");
}

/** A caption built from the client's own words, for a campaign whose writer did not complete. Agents always deliver. */
export function fallbackCampaignCaption(params: { productName?: string | undefined; slogan?: string | undefined; oneLiner?: string | undefined }): string {
  const lines = [params.productName, params.slogan, params.oneLiner].map((l) => clean(l)).filter((l): l is string => l !== undefined);
  const unique = lines.filter((l, i) => lines.findIndex((o) => o.toLowerCase() === l.toLowerCase()) === i);
  return unique.length > 0 ? unique.join("\n\n") : "Our product, in six scenes.";
}

// ─────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────

/** What the campaign did, on the gate payload and the persisted deliverable. */
export interface ProductCampaignReport {
  /** `shipped`: this post IS the campaign. `fell-back`: it was asked for and the normal carousel shipped instead, for `reason`. */
  status: "shipped" | "fell-back";
  reason?: string;
  requestedBy?: "run-input" | "client-config" | "client-preference";
  productPhoto?: { path: string; origin: ProductPhotoOrigin; fitScore?: number; durableUri?: string };
  productName?: string;
  scenes?: Array<{ n: number; id: CampaignSceneId; label: string; lettering?: string; status: "shipped" | "dropped"; rounds: number; reasons: string[] }>;
  /** Images this campaign generated (every round). */
  generated?: number;
  notes: string[];
}
