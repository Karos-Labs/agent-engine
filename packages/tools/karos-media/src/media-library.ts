import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, notAvailable, success, toolingError, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX } from "./find-images.js";

/**
 * RFC-14 item T — the client media library.
 *
 * ## The defect this closes
 *
 * A client upload lives in `.media-cache/<runId>/` on whichever worker
 * happened to run that post. It is read once, rendered once, and then it is
 * gone: the next run for the same client starts from zero and pays a stock
 * search (or a generation) for a picture the client already handed us. Worse,
 * the vision description `media.inspectImages` produced for that upload —
 * the sentence a copywriter and the vetting agent both actually read — is
 * thrown away with it, so the *second* time the same frame appears it costs
 * another vision call to find out what is in it.
 *
 * This is the one item in Phase 2/3 that genuinely needs new tools. Persisting
 * an upload means writing the client workspace, and an agent cannot write the
 * workspace except through a tool.
 *
 * ## Three rules this file is built around
 *
 * 1. **The identity of a frame is its bytes.** `assetId` is the first 16 hex
 *    characters of `sha256(bytes)`, computed HERE from the file the caller
 *    names — never supplied by the caller. The same photograph re-uploaded
 *    under a different filename, in a different run, is the same row; a row
 *    can therefore accumulate a use history rather than fragmenting into one
 *    entry per upload. `gcsUri` is where the bytes durably live and a signed
 *    URL is a convenience, never the identity — the same split
 *    `RenderCarouselResult` already makes.
 *
 * 2. **The library stores what was already learned, and never re-learns it.**
 *    `description`/`subjects`/`textInImage`/`mood` are copied verbatim from
 *    the `media.inspectImages` pass the upload already paid for, with the
 *    identity named (per that tool's prompt). A later run reading a library
 *    entry therefore costs NO vision call — which is the whole saving.
 *    `inspectedByToolVersion` records which version produced them, so a
 *    mismatch *permits* a re-inspection rather than requiring one: a stale
 *    sentence about a real photograph is still a true sentence about a real
 *    photograph.
 *
 * 3. **A row is a record, not an object.** Eviction at `MEDIA_LIBRARY_LIMIT`
 *    drops the oldest entry that has never shipped — the ROW, never the
 *    stored object. Nothing here deletes anything a client uploaded, and
 *    `WorkspaceStoreLike` has no delete in the first place (which is why the
 *    library is one document holding an array rather than one document per
 *    asset: dropping an entry has to be a write, not an unlink).
 */

/** Where a client's media library lives, as `WorkspaceStoreLike` segments. ONE document holding the whole array — see rule 3 above. */
export const MEDIA_LIBRARY_SEGMENTS = ["client", "media-library"] as const;

/**
 * How many entries one client's library keeps.
 *
 * A ceiling rather than unbounded growth because this document is read whole
 * on every `media.libraryList` call, and because a library nobody prunes stops
 * being an archive and becomes a landfill. 500 frames is roughly ten years of
 * weekly carousels at six slides each — past the point where the oldest rows
 * are still plausible material for a new post. Retention beyond that is a
 * manager's decision, not this tool's.
 */
export const MEDIA_LIBRARY_LIMIT = 500;

/** Stamped on the stored document so a future shape change can be detected rather than guessed at. */
export const MEDIA_LIBRARY_SCHEMA_ID = "karos.media-library.v1";

// 1.0.0 — new in RFC-14 item T.
const ADD_TOOL_VERSION = "1.0.0";
const LIST_TOOL_VERSION = "1.0.0";

/** `sha256` is 64 hex characters; the first 16 give 64 bits — collision-free at any library size this cap allows, and short enough to read in a trace. */
const ASSET_ID_HEX_CHARS = 16;

/**
 * How many `.media-cache/` paths one entry remembers.
 *
 * These exist for exactly one reason: `ledger.listUsedImages` records PATHS,
 * and its rules stay authoritative (RFC-14 item T). A library entry that could
 * not say which paths it has been known by could not be matched against that
 * list, and the "never reuse a shipped frame" guarantee would silently stop
 * covering re-ingested library media. Twelve is generous — a frame re-ingested
 * more than twelve times is already excluded by its own `usedIn`.
 */
const MAX_KNOWN_PATHS = 12;

const DEFAULT_LIST_LIMIT = 24;
const MAX_LIST_LIMIT = 60;

/** Same per-image ceiling `media.findImages` downloads under. A carousel slide never needs more. */
const MAX_ENTRY_BYTES = 12 * 1024 * 1024;

/** Extensions the library files. Anything else is skipped with a named reason rather than filed as an unknown blob. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// ─────────────────────────────────────────────────────────────────────────────
// Scene tags
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One token as it is compared.
 *
 * NFKD + strip `\p{M}` + lowercase, in that order, is what makes the match
 * script-insensitive in the only sense that is honest: it folds the marks a
 * script writes optionally, not one alphabet into another. Hebrew niqqud,
 * Arabic harakat and Latin diacritics are all `\p{M}`, so `כַּדוּרֶגֶל` and
 * `כדורגל`, `café` and `cafe` compare equal — while `toLowerCase()` alone is a
 * no-op in a caseless script and would have left Hebrew matching on exact
 * bytes. Punctuation and whitespace collapse so `"bar-chart"` and `"bar chart"`
 * are one thing.
 */
export function normaliseSceneToken(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Shortest token worth indexing. Two, not three: a Hebrew or CJK noun is routinely two characters, and an English one-letter token is never a scene. */
const MIN_TAG_LENGTH = 2;

/** Ceiling on one entry's tags — this is a retrieval index, not a transcript. */
const MAX_SCENE_TAGS = 24;

/**
 * Splits free text into the tags it contributes: the whole normalised phrase
 * AND its individual words.
 *
 * Both, because a query and a subject rarely agree on granularity — the vision
 * model returns `"conference stage"` and the slide's scene brief says
 * `"a speaker on a conference stage"`. Phrase-only matching misses that;
 * word-only matching loses the phrase a later exact query would hit.
 */
function tagsFromText(value: string): string[] {
  const phrase = normaliseSceneToken(value);
  if (phrase.length < MIN_TAG_LENGTH) return [];
  const words = phrase.split(" ").filter((w) => w.length >= MIN_TAG_LENGTH);
  return words.length > 1 ? [phrase, ...words] : [phrase];
}

/**
 * The scene tags one inspected image is filed under — derived IN CODE from
 * what the vision model already said, never authored by a model.
 *
 * Deliberately derived rather than asked for: a second model call to "tag this
 * image" would cost money to reproduce information `subjects` and `mood`
 * already carry, and would let the tag vocabulary drift call by call.
 */
export function sceneTagsFor(subjects: readonly string[], mood: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of [...subjects, mood]) {
    if (typeof value !== "string") continue;
    for (const tag of tagsFromText(value)) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
      if (out.length === MAX_SCENE_TAGS) return out;
    }
  }
  return out;
}

/** Every tag a free-text scene query should be matched on. Same derivation as the stored side, so a query and an entry can never disagree about what a word is. */
export function sceneQueryTags(query: string): string[] {
  return sceneTagsFor([query], "");
}

// ─────────────────────────────────────────────────────────────────────────────
// The stored shape
// ─────────────────────────────────────────────────────────────────────────────

/** How defensible this frame's licence is. A client upload is the strongest basis there is: they own it and they chose it. */
export const MediaLibraryRightsSchema = z.object({
  source: z.string().min(1).describe("Where the frame came from — \"client-upload\", a provider name, or the page it was harvested from."),
  licence: z.string().min(1).describe("The licence line recorded at ingestion. Travels with the entry because the rights gate reads it, not the filename."),
  note: z.string().min(1).optional().describe("Anything a reviewer would need to know about the rights that the licence line does not say."),
});
export type MediaLibraryRights = z.infer<typeof MediaLibraryRightsSchema>;

/** One shipped use of a frame. `(runId, slide)` is the identity, so a resumed or retried delivery appends nothing. */
export const MediaLibraryUseSchema = z.object({
  runId: z.string().min(1),
  slide: z.number().int().positive(),
  at: z.string().min(1),
});
export type MediaLibraryUse = z.infer<typeof MediaLibraryUseSchema>;

export const MediaLibraryEntrySchema = z.object({
  /** First 16 hex of `sha256(bytes)`. Content-addressed, so the same frame is never filed twice. */
  assetId: z.string().min(1),
  sha256: z.string().min(1),
  /** Durable location — a `gs://` object or the `https://` URL the asset was uploaded from. A signed URL is a convenience and never the identity. */
  gcsUri: z.string().min(1),
  contentType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  addedAt: z.string().min(1),
  addedByRunId: z.string().min(1),
  rights: MediaLibraryRightsSchema,
  /** `media.inspectImages`' description, identity NAMED — the sentence a later run reads INSTEAD of paying for vision again. */
  description: z.string().min(1),
  subjects: z.array(z.string()).default([]),
  textInImage: z.array(z.string()).default([]),
  mood: z.string().default(""),
  /** Which `media.inspectImages` produced the description above. A mismatch permits re-inspection; it never invalidates the row. */
  inspectedByToolVersion: z.string().default(""),
  /** Derived in code from `subjects` + `mood` — see `sceneTagsFor`. */
  sceneTags: z.array(z.string()).default([]),
  /**
   * Repo-relative `.media-cache/` paths this frame has been known by, so
   * `ledger.listUsedImages` (which records paths) can still exclude it. Capped
   * at `MAX_KNOWN_PATHS`, newest last.
   */
  knownPaths: z.array(z.string()).default([]),
  usedIn: z.array(MediaLibraryUseSchema).default([]),
});
export type MediaLibraryEntry = z.infer<typeof MediaLibraryEntrySchema>;

const MediaLibraryDocumentSchema = z.object({
  schema: z.literal(MEDIA_LIBRARY_SCHEMA_ID),
  clientSlug: z.string().min(1),
  updatedAt: z.string().min(1),
  /** Oldest first — insertion order, which is also eviction order. `media.libraryList` reverses it. */
  entries: z.array(MediaLibraryEntrySchema),
});
export type MediaLibraryDocument = z.infer<typeof MediaLibraryDocumentSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// media.libraryAdd
// ─────────────────────────────────────────────────────────────────────────────

export const MediaLibraryAddEntrySchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(`Repo-relative path under ${MEDIA_CACHE_PREFIX}/, as the sourcing and ingestion tools return it. The bytes here are hashed to produce the entry's identity.`),
  gcsUri: z
    .string()
    .min(1)
    .optional()
    .describe("The frame's durable location — the gs:// object or https:// URL it was uploaded from. Required to CREATE an entry: a row nothing can re-fetch is a dead row."),
  rights: MediaLibraryRightsSchema.optional().describe("Provenance and licence. Required to create an entry; omitted on a use-only call, which keeps what is already filed."),
  description: z
    .string()
    .min(1)
    .optional()
    .describe("media.inspectImages' description for this frame, identity named. Required to create an entry — a library row with no description would cost a vision call to be useful, which is the cost this library exists to avoid."),
  subjects: z.array(z.string().min(1)).max(24).optional().describe("media.inspectImages' subjects. Feeds the scene tags this frame is retrieved by."),
  textInImage: z.array(z.string().min(1)).max(24).optional().describe("Legible text the vision pass transcribed."),
  mood: z.string().optional().describe("media.inspectImages' mood. Feeds the scene tags alongside subjects."),
  inspectedByToolVersion: z.string().min(1).optional().describe("The media.inspectImages version that produced the fields above, so a later mismatch can permit a re-inspection."),
  usedInSlides: z
    .array(z.number().int().positive())
    .max(20)
    .optional()
    .describe("Slides of THIS run that shipped this frame. Recorded against the calling run id, idempotently per (run, slide) — pass it once a post has actually shipped, never before."),
});
export type MediaLibraryAddEntry = z.input<typeof MediaLibraryAddEntrySchema>;

export const MediaLibraryAddInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. Every `path` below must resolve inside it, under the media cache."),
  entries: z.array(MediaLibraryAddEntrySchema).min(1).max(24).describe("The frames to file or update. Upserted by content hash, so re-filing the same bytes updates one row rather than adding a second."),
});
export type MediaLibraryAddInput = z.input<typeof MediaLibraryAddInputSchema>;

export interface MediaLibraryAddResult {
  /** Asset ids filed for the first time. */
  created: string[];
  /** Asset ids that already existed and were updated (including use-only calls). */
  updated: string[];
  /** How many `(runId, slide)` uses were genuinely new. A retried delivery reports 0. */
  usesAppended: number;
  /** Entries that could not be filed, each with the reason. Never silently dropped, and never a thrown failure: a library write is best-effort by contract. */
  skipped: Array<{ path: string; reason: string }>;
  /** Rows dropped to stay under `MEDIA_LIBRARY_LIMIT`. The ROW only — the stored object is never touched. */
  evicted: Array<{ assetId: string; reason: string }>;
  total: number;
}

export interface MediaLibraryToolsOptions {
  /** The client workspace the library document lives in. Absent means every call reports `not_available` — never a placeholder library. */
  store?: WorkspaceStoreLike | undefined;
  /** Injectable clock, so `addedAt`/`usedIn.at` ordering is assertable. Defaults to the wall clock. */
  now?: () => Date;
}

/** Resolves `path` inside `repoRoot` and under the media cache, or says why it refused. Same guard `media.stageAsset` applies, for the same reason. */
function resolveCachedPath(repoRoot: string, relative: string): { absolute: string } | { reason: string } {
  const rootResolved = path.resolve(repoRoot);
  const absolute = path.resolve(repoRoot, relative);
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) {
    return { reason: `path escapes repoRoot ("${relative}")` };
  }
  if (!relative.replace(/\\/g, "/").startsWith(`${MEDIA_CACHE_PREFIX}/`)) {
    return { reason: `only files under ${MEDIA_CACHE_PREFIX}/ are filed ("${relative}")` };
  }
  return { absolute };
}

async function readLibrary(
  store: WorkspaceStoreLike,
  clientSlug: string,
): Promise<{ document: MediaLibraryDocument } | { reason: string }> {
  let raw: unknown;
  try {
    raw = await store.readJson<unknown>(clientSlug, [...MEDIA_LIBRARY_SEGMENTS]);
  } catch (error) {
    return { reason: `the media library for "${clientSlug}" could not be read (${(error as Error).message})` };
  }
  if (raw === undefined) {
    return { document: { schema: MEDIA_LIBRARY_SCHEMA_ID, clientSlug, updatedAt: "", entries: [] } };
  }
  const parsed = MediaLibraryDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    // Deliberately a refusal rather than "start a fresh document": overwriting
    // an unparseable library would destroy every frame it holds. The caller's
    // contract is best-effort, so it records the reason and falls through to
    // the tiers below — which is a degraded run, not a lost archive.
    return { reason: `the media library for "${clientSlug}" does not match the stored schema (${parsed.error.message}) — refusing to overwrite it` };
  }
  return { document: parsed.data };
}

/** Trimmed, de-duplicated case-insensitively, order kept — the same hygiene `vision-annotation.ts` applies before a description reaches a prompt. */
function cleanList(values: readonly string[] | undefined, max: number): string[] | undefined {
  if (values === undefined) return undefined;
  const out: string[] = [];
  for (const value of values) {
    const text = value.replace(/\s+/gu, " ").trim();
    if (text.length === 0) continue;
    if (out.some((existing) => existing.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
    if (out.length === max) break;
  }
  return out;
}

/**
 * `media.libraryAdd` — files one or more frames in this client's media library,
 * upserted by content hash.
 *
 * Best-effort by construction: an entry that cannot be read, is too large, has
 * an unfilable type, or is missing the fields a NEW row needs is reported in
 * `skipped` with its reason and the rest are still filed. The caller (the
 * Instagram workflow's `05z`/`09g`) treats a failure as a note, never as a run
 * failure — the upload still works as a run attachment exactly as it did
 * before this library existed.
 */
export function createMediaLibraryAdd(options: MediaLibraryToolsOptions) {
  const now = options.now ?? (() => new Date());
  return defineTool<MediaLibraryAddInput, MediaLibraryAddResult>({
    name: "media.libraryAdd",
    description:
      "Files a client's media frames in their persistent media library, keyed by the sha256 of the bytes so the same frame is never filed twice. Stores the media.inspectImages description alongside it, so a later post can reuse the frame without paying for vision again, and appends the (run, slide) uses a shipped post made of it. Reports not_available when no client workspace is configured.",
    version: ADD_TOOL_VERSION,
    inputSchema: MediaLibraryAddInputSchema,
    async execute(rawInput, { ctx }) {
      const input = rawInput as z.output<typeof MediaLibraryAddInputSchema>;
      const store = options.store;
      if (store === undefined) {
        return notAvailable(
          "media.libraryAdd: no client workspace is configured, so uploads cannot be persisted past this run — wire a workspace store at the composition root",
        );
      }

      const read = await readLibrary(store, ctx.clientSlug);
      if ("reason" in read) return toolingError(`media.libraryAdd: ${read.reason}`);
      const entries = [...read.document.entries];
      const byAssetId = new Map(entries.map((entry, index) => [entry.assetId, index] as const));

      const at = now().toISOString();
      const created: string[] = [];
      const updated: string[] = [];
      const skipped: Array<{ path: string; reason: string }> = [];
      let usesAppended = 0;
      let changed = false;

      for (const requested of input.entries) {
        const resolved = resolveCachedPath(input.repoRoot, requested.path);
        if ("reason" in resolved) {
          skipped.push({ path: requested.path, reason: resolved.reason });
          continue;
        }
        const contentType = CONTENT_TYPES[path.extname(resolved.absolute).toLowerCase()];
        if (contentType === undefined) {
          skipped.push({ path: requested.path, reason: `unsupported file type "${path.extname(resolved.absolute)}"` });
          continue;
        }

        let bytes: Buffer;
        try {
          bytes = await fs.readFile(resolved.absolute);
        } catch (error) {
          skipped.push({ path: requested.path, reason: `could not be read (${(error as Error).message})` });
          continue;
        }
        if (bytes.byteLength === 0) {
          skipped.push({ path: requested.path, reason: "the file is empty" });
          continue;
        }
        if (bytes.byteLength > MAX_ENTRY_BYTES) {
          skipped.push({ path: requested.path, reason: `${bytes.byteLength} bytes exceeds the ${MAX_ENTRY_BYTES}-byte ceiling` });
          continue;
        }

        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const assetId = sha256.slice(0, ASSET_ID_HEX_CHARS);
        const normalisedPath = requested.path.replace(/\\/g, "/");
        const existingIndex = byAssetId.get(assetId);

        const subjects = cleanList(requested.subjects, 24);
        const textInImage = cleanList(requested.textInImage, 24);
        const description = requested.description?.replace(/\s+/gu, " ").trim();
        const mood = requested.mood?.replace(/\s+/gu, " ").trim();

        if (existingIndex === undefined) {
          // A NEW row needs the two things that make it worth keeping: somewhere
          // to fetch the bytes from once this worker's disk is gone, and the
          // sentence that spares the next run a vision call. Without either,
          // filing it would be filing a placeholder.
          const missing: string[] = [];
          if (requested.gcsUri === undefined) missing.push("gcsUri");
          if (description === undefined || description.length === 0) missing.push("description");
          if (requested.rights === undefined) missing.push("rights");
          if (missing.length > 0) {
            skipped.push({
              path: requested.path,
              reason: `no library entry exists for these bytes yet and this call supplies no ${missing.join("/")} — nothing was created, because a row that cannot be re-fetched or read back is worse than no row`,
            });
            continue;
          }
          const entry: MediaLibraryEntry = {
            assetId,
            sha256,
            gcsUri: requested.gcsUri!,
            contentType,
            bytes: bytes.byteLength,
            addedAt: at,
            addedByRunId: ctx.runId,
            rights: requested.rights!,
            description: description!,
            subjects: subjects ?? [],
            textInImage: textInImage ?? [],
            mood: mood ?? "",
            inspectedByToolVersion: requested.inspectedByToolVersion ?? "",
            sceneTags: sceneTagsFor(subjects ?? [], mood ?? ""),
            knownPaths: [normalisedPath],
            usedIn: [],
          };
          usesAppended += appendUses(entry, requested.usedInSlides ?? [], ctx.runId, at);
          byAssetId.set(assetId, entries.length);
          entries.push(entry);
          created.push(assetId);
          changed = true;
          continue;
        }

        // ── Upsert. `addedAt`/`addedByRunId` are the FIRST sighting and never
        // move: the library's ordering (and therefore its eviction) is about
        // when a frame entered the archive, not when it was last mentioned.
        const previous = entries[existingIndex]!;
        const knownPaths = previous.knownPaths.includes(normalisedPath)
          ? previous.knownPaths
          : [...previous.knownPaths, normalisedPath].slice(-MAX_KNOWN_PATHS);
        const nextSubjects = subjects ?? previous.subjects;
        const nextMood = mood ?? previous.mood;
        const next: MediaLibraryEntry = {
          ...previous,
          ...(requested.gcsUri !== undefined ? { gcsUri: requested.gcsUri } : {}),
          ...(requested.rights !== undefined ? { rights: requested.rights } : {}),
          ...(description !== undefined && description.length > 0 ? { description } : {}),
          subjects: nextSubjects,
          ...(textInImage !== undefined ? { textInImage } : {}),
          mood: nextMood,
          ...(requested.inspectedByToolVersion !== undefined ? { inspectedByToolVersion: requested.inspectedByToolVersion } : {}),
          sceneTags: sceneTagsFor(nextSubjects, nextMood),
          knownPaths,
          usedIn: [...previous.usedIn],
        };
        usesAppended += appendUses(next, requested.usedInSlides ?? [], ctx.runId, at);
        entries[existingIndex] = next;
        if (!updated.includes(assetId)) updated.push(assetId);
        changed = true;
      }

      const evicted = evictToLimit(entries);
      if (evicted.length > 0) changed = true;

      if (changed) {
        const document: MediaLibraryDocument = {
          schema: MEDIA_LIBRARY_SCHEMA_ID,
          clientSlug: ctx.clientSlug,
          updatedAt: at,
          entries,
        };
        try {
          await store.writeJson(ctx.clientSlug, [...MEDIA_LIBRARY_SEGMENTS], document);
        } catch (error) {
          return toolingError(`media.libraryAdd: the media library could not be written (${(error as Error).message})`);
        }
      }

      return success<MediaLibraryAddResult>({ created, updated, usesAppended, skipped, evicted, total: entries.length });
    },
  });
}

/** Appends `(runId, slide)` uses that are not already recorded. Idempotent, so a resumed or retried delivery double-counts nothing. */
function appendUses(entry: MediaLibraryEntry, slides: readonly number[], runId: string, at: string): number {
  let appended = 0;
  for (const slide of slides) {
    if (entry.usedIn.some((use) => use.runId === runId && use.slide === slide)) continue;
    entry.usedIn.push({ runId, slide, at });
    appended++;
  }
  return appended;
}

/**
 * Trims the library back to `MEDIA_LIBRARY_LIMIT`, dropping the oldest entry
 * that has NEVER shipped first.
 *
 * Never-shipped-first is the whole rule: a frame that has been in a post is
 * evidence about this client's feed (and about what must not be reused), while
 * one that has sat unused since it was uploaded is the cheapest thing to
 * forget. When every entry has shipped, the least recently USED one goes — the
 * alternative is a library that silently ignores its own cap. Either way this
 * drops a ROW; the stored object is untouched and can be re-filed at any time.
 */
function evictToLimit(entries: MediaLibraryEntry[]): Array<{ assetId: string; reason: string }> {
  const evicted: Array<{ assetId: string; reason: string }> = [];
  while (entries.length > MEDIA_LIBRARY_LIMIT) {
    let victim = entries.findIndex((entry) => entry.usedIn.length === 0);
    let reason = `oldest entry that has never shipped, dropped to stay under the ${MEDIA_LIBRARY_LIMIT}-entry cap (the row only — the stored object is untouched)`;
    if (victim === -1) {
      // Every entry has shipped: fall back to least-recently-used, computed
      // from the uses themselves rather than from insertion order.
      let oldest: string | undefined;
      victim = 0;
      entries.forEach((entry, index) => {
        const last = entry.usedIn.reduce((max, use) => (use.at > max ? use.at : max), "");
        if (oldest === undefined || last < oldest) {
          oldest = last;
          victim = index;
        }
      });
      reason = `every entry has shipped, so the least recently used one was dropped to stay under the ${MEDIA_LIBRARY_LIMIT}-entry cap (the row only — the stored object is untouched)`;
    }
    evicted.push({ assetId: entries[victim]!.assetId, reason });
    entries.splice(victim, 1);
  }
  return evicted;
}

// ─────────────────────────────────────────────────────────────────────────────
// media.libraryList
// ─────────────────────────────────────────────────────────────────────────────

export const MediaLibraryListInputSchema = z.object({
  sceneTags: z
    .array(z.string().min(1))
    .max(24)
    .optional()
    .describe("Scene words to retrieve on — free text is fine, it is normalised the same way the stored tags are. An entry matching ANY of them is returned; omitted returns everything."),
  excludeUsedInRunIds: z
    .array(z.string().min(1))
    .max(24)
    .optional()
    .describe("Run ids whose shipped frames must not come back. The immediately previous post's run id belongs here: that is what stops the same frame appearing twice in a row."),
  currentInspectionVersion: z
    .string()
    .min(1)
    .optional()
    .describe("The media.inspectImages version the caller is running. Entries described by a different version are still returned, and also named in staleInspections — a mismatch permits a re-inspection, it never hides the frame."),
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT).describe("How many entries to return, newest first."),
});
export type MediaLibraryListInput = z.input<typeof MediaLibraryListInputSchema>;

export interface MediaLibraryListResult {
  /** Newest first. */
  entries: MediaLibraryEntry[];
  /** Entries in the library before any filter. */
  total: number;
  /** Entries that survived the filters, before `limit`. */
  matched: number;
  /** Asset ids (among those returned) whose description came from a different `media.inspectImages` version. Permission to re-inspect, not a requirement. */
  staleInspections: string[];
}

/**
 * `media.libraryList` — this client's filed frames, newest first.
 *
 * Read-only and free. Every returned entry already carries the description a
 * vetting agent reads, so a candidate drawn from here costs no vision call —
 * which is exactly why it is worth consulting before a stock search.
 */
export function createMediaLibraryList(options: MediaLibraryToolsOptions) {
  return defineTool<MediaLibraryListInput, MediaLibraryListResult>({
    name: "media.libraryList",
    description:
      "Lists the frames in this client's media library, newest first, filtered by scene words and by the runs whose shipped frames must not come back. Every entry carries the stored media.inspectImages description, so reusing one costs no vision call. Reports not_available when no client workspace is configured.",
    version: LIST_TOOL_VERSION,
    inputSchema: MediaLibraryListInputSchema,
    async execute(rawInput, { ctx }) {
      const input = rawInput as z.output<typeof MediaLibraryListInputSchema>;
      const store = options.store;
      if (store === undefined) {
        return notAvailable("media.libraryList: no client workspace is configured, so this client has no media library to read");
      }

      const read = await readLibrary(store, ctx.clientSlug);
      if ("reason" in read) return toolingError(`media.libraryList: ${read.reason}`);
      const all = read.document.entries;

      const excluded = new Set(input.excludeUsedInRunIds ?? []);
      const wanted = new Set((input.sceneTags ?? []).flatMap((tag) => sceneQueryTags(tag)));

      const matched = all.filter((entry) => {
        if (excluded.size > 0 && entry.usedIn.some((use) => excluded.has(use.runId))) return false;
        if (wanted.size === 0) return true;
        return entry.sceneTags.some((tag) => wanted.has(tag));
      });

      // Newest first: the array is stored oldest-first (insertion order), so a
      // reverse is the whole sort — `addedAt` ties on a batch filed in one call
      // and insertion order is the only stable tiebreak there is.
      const newestFirst = [...matched].reverse();
      const entries = newestFirst.slice(0, input.limit);
      const staleInspections =
        input.currentInspectionVersion === undefined
          ? []
          : entries.filter((entry) => entry.inspectedByToolVersion !== input.currentInspectionVersion).map((entry) => entry.assetId);

      return success<MediaLibraryListResult>({ entries, total: all.length, matched: matched.length, staleInspections });
    },
  });
}

/** Both library tools, for a composition root that wires them together. */
export function createMediaLibraryTools(options: MediaLibraryToolsOptions) {
  return {
    "media.libraryAdd": createMediaLibraryAdd(options),
    "media.libraryList": createMediaLibraryList(options),
  };
}
