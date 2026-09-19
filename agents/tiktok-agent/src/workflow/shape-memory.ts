import type { ShortScript } from "./types.js";

/**
 * What this account has already MADE, as opposed to what it has already said.
 *
 * ## The defect
 *
 * The topic catalog and `checkOutputDedupe` both answer "have we said this
 * before". Nothing answered "have we made this before", and the owner's
 * standing ruling is that *repetition across runs is the AI tell*. Two
 * concrete ways this agent repeated itself with every check passing:
 *
 * 1. **The same library clip.** `usedStockIds` was scoped to ONE run, so the
 *    exclusion reset every time. Pexels' results for "office desk" are stable,
 *    so two shorts a week apart on adjacent topics open on the same footage,
 *    and both pass every gate because neither knows about the other.
 * 2. **The same skeleton.** Every original short is a cold open, four beats
 *    and a turn, in the same rhythm, opening on the same device. Nobody
 *    watching one short notices; anybody watching an account's last six does.
 *
 * ## Why this rides on the used-media ledger rather than a new tool
 *
 * `ledger.recordUsedImages` / `ledger.listUsedImages` is already "the set of
 * strings this client has used", client-scoped, insertion-ordered and
 * idempotent per string — which is exactly the shape this needs. A parallel
 * tool would mean a new schema, a `TOOL_VERSION` bump and a second store to
 * keep consistent, to hold a list of strings beside an existing list of
 * strings. Every entry is NAMESPACED (`tiktok:`) so it can never be mistaken
 * for instagram's image paths, which share the same list.
 *
 * ## What is recorded, and when
 *
 * On commit, after a human approved the clip — the ledger's own rule, "an
 * image that never shipped was never used". A rejected short's shape is
 * deliberately NOT remembered: it never reached anyone's feed, so it cannot
 * have made the account look repetitive.
 */

/** The prefix that separates this agent's entries from every other consumer of the shared used-media ledger. */
const NAMESPACE = "tiktok:";
const STOCK_PREFIX = `${NAMESPACE}stock:`;
const SHAPE_PREFIX = `${NAMESPACE}shape:`;
const CLIP_PREFIX = `${NAMESPACE}clip:`;

/** How many recent shapes the writer is shown. Enough to see a pattern, short enough to read. */
export const SHAPE_WINDOW = 6;

/**
 * How a short OPENS, as a deterministic fact about its first line rather than
 * an interpretation of it.
 *
 * Every member is decidable by looking at the characters, which is the whole
 * point: an opener that needed a model to classify would be a judgment call
 * recorded as data, and two runs would disagree about the same hook. The
 * categories are the ones a viewer actually experiences as different, in the
 * order they are tested — a hook can be two of these at once, and the first
 * match wins so the classification is total and stable.
 */
export type OpeningDevice = "number" | "question" | "second-person" | "negation" | "statement";

/**
 * A whole-word matcher that works in Hebrew as well as in English.
 *
 * `\b` is ASCII-only even under the `u` flag — between a space and "ע" there
 * is no word boundary, so `/\bלא\b/u` matches nothing at all, while a bare
 * `/לא/` matches inside "שלא" ("that … not") and misreads it. Letter
 * lookarounds are the boundary that actually holds in both scripts.
 * instagram-agent's `target-language.ts` documents the same trap; this is the
 * second place in the repo to hit it.
 */
function wordsPattern(words: readonly string[]): RegExp {
  return new RegExp(`(?<!\\p{L})(?:${words.join("|")})(?!\\p{L})`, "iu");
}

/** Second person, in the two languages this agent's clients publish in. */
const SECOND_PERSON = wordsPattern(["you", "your", "you're", "you'll", "את", "אתה", "שלך", "שלכם"]);
/** An opener that denies something — "nobody tells you", "it isn't", "אף אחד לא". */
const NEGATION = wordsPattern(["no", "not", "never", "nobody", "nothing", "isn't", "don't", "doesn't", "won't", "can't", "לא", "אין", "אף"]);

/**
 * How many words count as the OPENING.
 *
 * The device is about how a hook starts, not what it contains. "Your budget is
 * going to placements you never approved" opens on second person and happens
 * to carry a negation seven words later; reading the whole line classifies it
 * as a negation, which is not what a viewer experiences. Six words is about
 * the first breath.
 */
const OPENING_WORDS = 6;

/** Which of the five devices a hook opens on. Exported for the test. */
export function openingDevice(hook: string): OpeningDevice {
  const text = hook.trim();
  // A leading figure is the loudest opener there is and reads as one whatever
  // else is in the line, so it is tested before everything — including a
  // question mark, since "3 things nobody tells you?" opens on the 3.
  if (/^[^\p{L}]*\d/u.test(text)) return "number";
  if (text.includes("?")) return "question";
  const opening = text.split(/\s+/).slice(0, OPENING_WORDS).join(" ");
  if (NEGATION.test(opening)) return "negation";
  if (SECOND_PERSON.test(opening)) return "second-person";
  return "statement";
}

/**
 * One short's structural fingerprint.
 *
 * Structure only, never subject: two shorts about different things built the
 * same way are the repetition this catches, and two shorts about the same
 * thing built differently are not this module's problem (that is the topic
 * catalog's and `checkOutputDedupe`'s).
 */
export function skeletonOf(script: Pick<ShortScript, "format" | "beats" | "hook" | "voiceover">): string {
  const statBeats = script.beats.filter((b) => b.stat !== undefined).length;
  return [script.format, `${script.beats.length}beats`, `${statBeats}stat`, script.voiceover ? "voiced" : "silent", openingDevice(script.hook)].join("/");
}

export function stockClipEntry(pexelsId: number): string {
  return `${STOCK_PREFIX}${pexelsId}`;
}

export function skeletonEntry(skeleton: string): string {
  return `${SHAPE_PREFIX}${skeleton}`;
}

/**
 * A window of a source recording this client has already published.
 *
 * The clipping agent had NO cross-run memory of any kind until 2026-09-19:
 * `skeletonOf` runs only for an original short, and a commentary clip buys no
 * library footage, so nothing at all was recorded. The topic catalog stopped
 * the same SUBJECT being made twice and nothing stopped the same forty seconds
 * of the same episode being cut twice — a client with one long podcast and a
 * broad topic could be handed overlapping clips weeks apart, each passing
 * every check.
 *
 * `source` is whatever names the recording: the harvested URL, the attached
 * asset's URI, or a dispatched `sourcePath`. It is stored verbatim rather than
 * hashed, so a human reading this client's ledger can see which episode a
 * window belongs to.
 */
export function clipWindowEntry(source: string, startSeconds: number, endSeconds: number): string {
  return `${CLIP_PREFIX}${Math.round(startSeconds)}-${Math.round(endSeconds)}@${source}`;
}

/** One previously published window of one recording. */
export interface ClippedWindow {
  source: string;
  startSeconds: number;
  endSeconds: number;
}

/** Whether two windows of the SAME recording overlap at all. Different recordings never overlap, whatever their timestamps say. */
export function windowsOverlap(a: ClippedWindow, b: ClippedWindow): boolean {
  return a.source === b.source && a.startSeconds < b.endSeconds && b.startSeconds < a.endSeconds;
}

export interface ShapeMemory {
  /** Library clips this client's shorts have already used, so a new one is genuinely new footage. */
  usedStockIds: number[];
  /** The skeletons of this client's recent shorts, oldest first. */
  skeletons: string[];
  /** Windows of source recordings this client has already published a clip from. */
  clippedWindows: ClippedWindow[];
}

/**
 * Reads this agent's entries out of the shared used-media ledger, ignoring
 * everything that belongs to another consumer.
 *
 * Tolerant by construction: an entry that does not parse is skipped rather
 * than throwing. This list is append-only across every agent and every version
 * of this code, so it will eventually contain strings written by something
 * that does not exist yet, and a reader that threw on one would take the run
 * with it.
 */
export function parseShapeMemory(entries: readonly string[]): ShapeMemory {
  const usedStockIds: number[] = [];
  const skeletons: string[] = [];
  const clippedWindows: ClippedWindow[] = [];
  for (const entry of entries) {
    if (entry.startsWith(STOCK_PREFIX)) {
      const id = Number(entry.slice(STOCK_PREFIX.length));
      if (Number.isInteger(id) && id > 0) usedStockIds.push(id);
    } else if (entry.startsWith(SHAPE_PREFIX)) {
      const shape = entry.slice(SHAPE_PREFIX.length);
      if (shape.length > 0) skeletons.push(shape);
    } else if (entry.startsWith(CLIP_PREFIX)) {
      // `<start>-<end>@<source>`. Split on the FIRST "@" only: a source is a
      // URL and routinely contains more.
      const rest = entry.slice(CLIP_PREFIX.length);
      const at = rest.indexOf("@");
      const span = at === -1 ? "" : rest.slice(0, at);
      const source = at === -1 ? "" : rest.slice(at + 1);
      const [from, to] = span.split("-").map((n) => Number(n));
      if (source.length > 0 && Number.isFinite(from) && Number.isFinite(to) && to! > from!) {
        clippedWindows.push({ source, startSeconds: from!, endSeconds: to! });
      }
    }
  }
  return { usedStockIds, skeletons, clippedWindows };
}

/**
 * What the moment picker is told about this recording, or `undefined` when
 * this client has never published a clip from it.
 *
 * A steer, deliberately, not an exclusion. A long episode can legitimately
 * yield two good clips, and refusing an overlap in code would silently veto
 * the best moment in a recording because a worse one near it went out first.
 * The picker is shown what has already been used and asked to find something
 * else; the run records the overlap if it picks one anyway.
 */
export function clippedWindowDirective(source: string, windows: readonly ClippedWindow[]): string | undefined {
  const mine = windows.filter((w) => w.source === source);
  if (mine.length === 0) return undefined;
  const spans = mine.map((w) => `${Math.round(w.startSeconds)}s-${Math.round(w.endSeconds)}s`).join(", ");
  return (
    `This client has ALREADY published a clip from this recording, cut at ${spans}. ` +
    `Pick a moment outside those windows: a viewer scrolling this account would meet the same seconds twice. ` +
    `If the strongest moment in the recording genuinely sits inside one of them, say so in your rationale and pick it anyway - ` +
    `a worse clip is not an improvement on a repeated one.`
  );
}

/**
 * What the writer is told about the shapes this account keeps making, or
 * `undefined` when there is no pattern worth naming.
 *
 * Only ever names a device or a beat count that is a genuine MAJORITY of the
 * recent window, and only once there is a window to speak of. Two shorts is
 * not a rut, and telling a writer to avoid the only structure it has used
 * twice would make the shorts worse rather than more varied — the note has to
 * describe something a viewer would actually notice.
 */
export function shapeRepeatDirective(skeletons: readonly string[]): string | undefined {
  const recent = skeletons.slice(-SHAPE_WINDOW);
  if (recent.length < 3) return undefined;

  const notes: string[] = [];
  const majority = (values: string[], label: (value: string, n: number) => string): string | undefined => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (best === undefined || best[1] * 2 <= values.length) return undefined;
    return label(best[0], best[1]);
  };

  const parts = recent.map((s) => s.split("/"));
  const device = majority(
    parts.map((p) => p[4] ?? ""),
    (value, n) => `${n} of this account's last ${recent.length} shorts open on the same device (${value})`,
  );
  const beats = majority(
    parts.map((p) => p[1] ?? ""),
    (value, n) => `${n} of the last ${recent.length} are the same length (${value})`,
  );
  if (device !== undefined) notes.push(device);
  if (beats !== undefined) notes.push(beats);
  if (notes.length === 0) return undefined;

  return (
    `Structural repetition on this account: ${notes.join("; ")}. ` +
    `Nobody watching ONE short notices; anybody scrolling this account's last six does, and sameness of shape is the clearest tell that a machine made them. ` +
    `Build this one differently — a different number of beats, or a hook that opens on something other than the device above. ` +
    `Do not change the subject or weaken the idea to do it: the structure is what varies, never the substance.`
  );
}
