import { sceneQueryTags, sceneTagsFor, type MediaLibraryAddEntry, type MediaLibraryEntry, type MediaLibraryRights } from "@agent-engine/tool-karos-media";
import { buildVisionAnnotation } from "./vision-annotation.js";

/**
 * RFC-14 item T — the workflow half of the client media library.
 *
 * `media.libraryAdd` / `media.libraryList` own the storage; everything here is
 * pure, free, and testable without a workspace. Three jobs:
 *
 * 1. **Turn an inspected upload into the row that should be filed** —
 *    `buildLibraryEntry`, called at `05z` once the vision pass has already run
 *    and the run is holding its answer.
 * 2. **Decide which filed frames may compete for THIS post's slides** —
 *    `selectLibraryCandidates`, called at `05y`, before any paid sourcing.
 * 3. **Say what a library frame is, in the words the vetting agent reads** —
 *    `describeLibraryCandidate`, so a frame drawn from the archive is judged
 *    on the same kind of sentence as a freshly inspected one and costs no
 *    second vision call to produce it.
 *
 * ## Why this tier sits where it does
 *
 * Tier 0 is media the client attached to THIS run: they have told us exactly
 * what they want on the slide, and nothing outranks that. The library is tier
 * **0.5** — media the client gave us for an EARLIER run. It outranks stock
 * because it is still the client's own picture of the client's own world, and
 * it is strictly cheaper than stock: the description is already on file, so
 * offering it costs no vision call and no retrieval call. It sits below tier 0
 * because a fresh upload is a fresh instruction and an archived one is not.
 */

/**
 * The `rights.source` a client's own upload is filed under, and the rights
 * block `05z` files it with.
 *
 * One constant rather than two string literals, because `isClientOwnedFrame`
 * turns on it and `describeLibraryCandidate` is what tells the vetting agent
 * whose picture this is and under what licence. A row filed under a source
 * the reader does not recognise would be described to the vet as third-party
 * media, which is safe but wrong; a drifting literal is how that would happen
 * silently. It deliberately does NOT decide which reuse rule governs a frame
 * — the ledger's cross-post rule governs all of them.
 */
export const CLIENT_UPLOAD_RIGHTS_SOURCE = "client-upload";
export const CLIENT_UPLOAD_RIGHTS: MediaLibraryRights = {
  source: CLIENT_UPLOAD_RIGHTS_SOURCE,
  licence: "client-supplied — owned by the client, uploaded deliberately for this post",
};

/** True when this row is the CLIENT'S OWN frame rather than something harvested — the fact the rights sentence handed to the vet turns on. */
export function isClientOwnedFrame(entry: Pick<MediaLibraryEntry, "rights">): boolean {
  return entry.rights.source.trim().toLowerCase() === CLIENT_UPLOAD_RIGHTS_SOURCE;
}

/**
 * The slot `media.ingestAssets` encoded in a staged file's name, or
 * `undefined` when the name does not carry one.
 *
 * **This is the only honest way to pair an ingested candidate with the asset
 * it came from.** `media.ingestAssets` returns `candidates` as the SUCCESSFUL
 * SUBSET of its input (`ingest-assets.ts` pushes to `unmet` and `continue`s on
 * an unreadable object, an empty object, a missing GCS reader or a bad
 * scheme), so `candidates[i]` is not `assets[i]` the moment one attachment
 * fails: every later frame shifts up by one. Pairing by array index there puts
 * one picture's description, licence and durable URI on a different
 * photograph — silently, and durably once it is filed.
 *
 * Both of that tool's writers name the file `n<slot>-…` (`n${asset.slot}-client${i}`
 * for `gs://`, and `downloadImage`'s `n${n}-${hash}` for `https://`), and
 * `packages/tools/karos-media/__tests__/ingest-assets.test.ts` pins that
 * naming so this parser cannot rot silently. The separator is matched as "any
 * non-digit" rather than as a literal `-`, so a stem of `n1.png` reads as
 * slot 1 too: the digits are the contract, the punctuation after them is not.
 * A path that does not match is reported as unknown and the caller SKIPS the
 * frame — never guesses.
 */
export function ingestedSlotOf(stagedPath: string): number | undefined {
  const base = stagedPath.replace(/\\/g, "/").split("/").pop() ?? "";
  const match = /^n(\d+)(?=\D|$)/u.exec(base);
  if (match === null) return undefined;
  const slot = Number(match[1]);
  return Number.isSafeInteger(slot) && slot > 0 ? slot : undefined;
}

/** The `media.inspectImages` fields a library row is built from. Shaped as the workflow already holds them at `05z`. */
export interface LibraryInspection {
  description: string;
  subjects?: readonly string[];
  textInImage?: readonly string[];
  mood?: string;
  /** The `media.inspectImages` version that produced the fields above. A later mismatch permits a re-inspection; it never invalidates the row. */
  toolVersion?: string;
}

/** Where the frame is, for this run and for good. */
export interface LibraryStagedAsset {
  /** Repo-relative path under `.media-cache/`, as `media.ingestAssets` returned it. The library hashes these bytes to get the row's identity. */
  path: string;
  /** The durable location the upload came from — the `gs://` object or `https://` URL on `RunDirection.mediaAssets`. */
  uri: string;
  /** The uploader's own label, when they gave one. Carried so a reviewer can recognise the frame in the archive. */
  label?: string;
}

/**
 * The `media.libraryAdd` payload for one inspected upload.
 *
 * Deliberately NOT given the run id, even though the stored row carries an
 * `addedByRunId`: `media.libraryAdd` stamps that from the agent context. A run
 * id that travelled as an argument would be a run id a caller could get wrong
 * (or a model could name), and provenance that can be named is provenance that
 * can be mistaken — the same reason no `inputSchema` in this repo declares a
 * tenant field.
 */
export function buildLibraryEntry(inspection: LibraryInspection, staged: LibraryStagedAsset, rights: MediaLibraryRights): MediaLibraryAddEntry {
  const description = inspection.description.replace(/\s+/gu, " ").trim();
  return {
    path: staged.path,
    gcsUri: staged.uri,
    rights,
    // The label is part of what a human will recognise this row by, so it
    // rides in the description rather than being dropped on the floor — the
    // library has no separate title field and does not need one.
    description: staged.label ? `${description} (uploaded as "${staged.label}")` : description,
    ...(inspection.subjects && inspection.subjects.length > 0 ? { subjects: [...inspection.subjects] } : {}),
    ...(inspection.textInImage && inspection.textInImage.length > 0 ? { textInImage: [...inspection.textInImage] } : {}),
    ...(inspection.mood ? { mood: inspection.mood } : {}),
    ...(inspection.toolVersion ? { inspectedByToolVersion: inspection.toolVersion } : {}),
  };
}

/**
 * The scene tags one inspection files under.
 *
 * Re-exported from `@agent-engine/tool-karos-media` rather than reimplemented:
 * the tags a query is matched on and the tags a row is stored under have to be
 * derived by the SAME function, or retrieval quietly stops working the day one
 * of the two learns a new rule.
 */
export { sceneTagsFor };

/** One library frame offered for this post, with the evidence for why it was offered. */
export interface LibraryCandidate {
  entry: MediaLibraryEntry;
  /** Normalised scene tags this frame shares with the slide's scene. Empty when the caller asked for everything. */
  matchedTags: string[];
  /** `matchedTags.length`. Ranking only — a zero-score frame is still a legitimate offer when no scene was named. */
  matchScore: number;
}

export interface LibrarySelectionOptions {
  /**
   * Runs whose shipped frames must not be offered. The immediately previous
   * post's run id belongs here — taken from the newest skeleton-history entry
   * (item P), which this run has already read at `02k`. This is the brief's
   * "never reuses the same frame twice in a row", and it is a different rule
   * from `ledgerUsed` below: that one is "never twice, ever", this one is
   * "never back to back".
   */
  excludeUsedInRunIds?: readonly string[];
  /**
   * `ledger.listUsedImages`' answer, already read at `05a`. It records PATHS,
   * which is why a library entry remembers every `.media-cache/` path it has
   * been known by — without that, a re-ingested THIRD-PARTY frame would arrive
   * under a fresh path and slip past the one gate that has been preventing
   * cross-post image reuse since the parity audit.
   *
   * It is authoritative and it governs EVERY frame, the client's own uploads
   * included — see `selectLibraryCandidates`' own comment.
   */
  ledgerUsed?: readonly string[];
  /** How many frames to offer. Six is one per photo slide of a default carousel. */
  limit?: number;
}

export interface LibrarySelection {
  candidates: LibraryCandidate[];
  /** Every frame that was on file and did not make the cut, with the reason. Named rather than silently dropped, so a run can say why the archive did not help. */
  excluded: Array<{ assetId: string; reason: string }>;
}

const DEFAULT_LIBRARY_CANDIDATE_LIMIT = 6;

/**
 * Which filed frames may compete for this post's slides.
 *
 * Exclusions run before ranking: the cross-post rule, then the back-to-back
 * rule, then the scene. A frame that fails any of them is reported with its
 * reason rather than dropped, because "the library had nothing for this post"
 * and "the library had three frames and every one of them shipped last week"
 * are different facts about a run.
 *
 * ## Which rule governs which frame
 *
 * **Both rules govern every frame, and the ledger is authoritative.** Item T
 * is explicit — *"filtered by (a) `ledger.listUsedImages`' existing rules …
 * which remain authoritative, and (b) `excludeUsedInRunIds`"* — and the rule
 * it defers to is the parity audit's core rule 8, *"never repeat a picture
 * across slides, posts or examples"*. Exempting the client's own uploads from
 * it was tempting (they are finite, they are theirs, and a real account does
 * re-show its own pictures) and it is a change to a standing invariant, which
 * is not a change an implementation comment gets to make. It is not made
 * here. If the owner wants the archive's own frames to recycle on a
 * back-to-back rule alone, that is a decision recorded in a PR body against
 * this paragraph — and the one line it would take to make is the
 * `isClientOwnedFrame` branch this comment used to describe.
 *
 * What each rule is worth in practice:
 *
 * * **`ledgerUsed` — never twice, ever.** Matched across every
 *   `.media-cache/` path the entry has been known by, because `05y`
 *   re-ingests an archived object under a FRESH `.media-cache/<thisRunId>/`
 *   path and the current path would therefore never match. This is the only
 *   gate that catches cross-post reuse of a library frame: the run-level
 *   guard tests `usedImagesSet.has(s.imagePath)` against that same fresh
 *   path, so it never fires either.
 * * **`excludeUsedInRunIds` — never back to back.** A strict subset of the
 *   ledger rule for a frame whose whole history the ledger can see, and NOT
 *   dead: `knownPaths` is capped at `MAX_KNOWN_PATHS` (12, newest last), so a
 *   frame that has been re-ingested more times than that has paths the ledger
 *   holds and the entry has forgotten. It is also the rule that still bites
 *   for an archive filed before the ledger recorded a given path at all.
 *
 * `usedIn` and `09g` stay live regardless of which rule excludes a frame:
 * they are what lets a frame that HAS shipped survive eviction ahead of one
 * that never has, and what makes "where did this picture run" answerable.
 */
export function selectLibraryCandidates(
  entries: readonly MediaLibraryEntry[],
  sceneQuery: string,
  options: LibrarySelectionOptions = {},
): LibrarySelection {
  const ledgerUsed = new Set(options.ledgerUsed ?? []);
  const excludedRuns = new Set(options.excludeUsedInRunIds ?? []);
  const wanted = new Set(sceneQueryTags(sceneQuery));

  const candidates: LibraryCandidate[] = [];
  const excluded: Array<{ assetId: string; reason: string }> = [];

  for (const entry of entries) {
    const shippedPath = entry.knownPaths.find((known) => ledgerUsed.has(known));
    if (shippedPath !== undefined) {
      excluded.push({ assetId: entry.assetId, reason: `already shipped as ${shippedPath} — ledger.listUsedImages' cross-post rule, which is authoritative and governs every frame` });
      continue;
    }
    const backToBack = entry.usedIn.find((use) => excludedRuns.has(use.runId));
    if (backToBack !== undefined) {
      excluded.push({ assetId: entry.assetId, reason: `shipped in run ${backToBack.runId}, the immediately previous post — a frame is never reused twice in a row` });
      continue;
    }
    const matchedTags = wanted.size === 0 ? [] : entry.sceneTags.filter((tag) => wanted.has(tag));
    if (wanted.size > 0 && matchedTags.length === 0) {
      excluded.push({ assetId: entry.assetId, reason: `no scene overlap with "${sceneQuery}"` });
      continue;
    }
    candidates.push({ entry, matchedTags, matchScore: matchedTags.length });
  }

  // Best match first; among equals the newest frame, because an archive that
  // keeps re-offering its oldest picture is the repetition item P exists to
  // stop. `assetId` is the final tiebreak so the order is total and a fixture
  // cannot depend on array luck.
  candidates.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    if (a.entry.addedAt !== b.entry.addedAt) return a.entry.addedAt < b.entry.addedAt ? 1 : -1;
    return a.entry.assetId < b.entry.assetId ? -1 : 1;
  });

  const limit = options.limit ?? DEFAULT_LIBRARY_CANDIDATE_LIMIT;
  return { candidates: candidates.slice(0, limit), excluded };
}

/**
 * The candidate description the vetting agent reads for a library frame.
 *
 * Built from the STORED inspection, through the same `buildVisionAnnotation`
 * that annotates a freshly inspected candidate — so a frame from the archive
 * and a frame inspected this morning are judged on the same kind of sentence,
 * and `claimMatch`'s identity rubric gets the named subjects either way. The
 * `[client library]` prefix mirrors `05z`'s `[client upload, slot N]`: the vet
 * has no source field on `ImageCandidate` and tells tiers apart by this text.
 *
 * **The rights basis rides in this sentence, and it has to.** This string
 * REPLACES the description `media.ingestAssets` wrote when the frame was
 * re-staged, and that is the only place a candidate's licence is ever stated:
 * `ImageCandidate` has no rights field, so `instagram-image-vet`'s §2 reads
 * the licence out of the description and is instructed that an "unclear or
 * unverifiable licence means `false`, not a hopeful `true`" and that an
 * undeterminable watermark state is `false` too. A library frame described
 * without its basis would therefore be marked rights-unusable by a correct
 * vet, `isUnfillable` would drop it, and the slide it was offered for would
 * take a typographic downgrade — the whole tier silently unusable. So the
 * stored `rights` are restated in the words `ingest-assets` uses for the
 * client's own media, and §4 of `instagram-image-vet@4` names this prefix.
 */
export function describeLibraryCandidate(entry: MediaLibraryEntry): string {
  const filed = entry.addedAt.slice(0, 10);
  return `[client library, filed ${filed}] ${entry.description} ${libraryRightsSentence(entry)}${buildVisionAnnotation({ subjects: entry.subjects, textInImage: entry.textInImage })}`;
}

/**
 * The rights half of that sentence: an ownership clause for the client's own
 * frames, a plain provenance line for anything else, and in both cases the
 * stored licence verbatim in the `[licence: …]` shape every other tier's
 * description uses.
 */
export function libraryRightsSentence(entry: Pick<MediaLibraryEntry, "rights">): string {
  const licence = `[licence: ${entry.rights.licence}${entry.rights.note !== undefined && entry.rights.note.length > 0 ? `; ${entry.rights.note}` : ""}]`;
  return isClientOwnedFrame(entry)
    ? `The client owns this image and supplied it deliberately for an earlier post of theirs, so it is rights-cleared and unwatermarked unless the picture itself shows otherwise. ${licence}`
    : `Filed in this client's media library from ${entry.rights.source}. ${licence}`;
}

/**
 * The `media.ingestAssets` request that pulls a library frame back onto this
 * worker's disk.
 *
 * A library entry is a durable URI, not a file: the `.media-cache/` directory
 * it was first read from belongs to a run that finished months ago. Re-ingest
 * through the tool every other tier uses, so one set of content-type, size and
 * `assertInside` guarantees covers library media too — and so a frame whose
 * object a lifecycle rule has since deleted simply fails to ingest and is
 * skipped, the same degrade path every image tier already has.
 */
export function libraryIngestRequest(candidate: LibraryCandidate, slot: number): { uri: string; label: string; slot: number } {
  return { uri: candidate.entry.gcsUri, label: `client library ${candidate.entry.assetId}`, slot };
}

/**
 * Groups a delivered post's frames into one `media.libraryAdd` entry per file,
 * for `09g`.
 *
 * Grouped because a frame can legitimately appear on two slides of one
 * carousel, and `usedIn` is keyed by `(runId, slide)` — two separate calls
 * would be correct but would read and rewrite the whole library document
 * twice. Paths outside the media cache are left out here rather than being
 * sent to be refused: the tool would skip them anyway, and a note about a
 * rendered slide PNG is noise in a delivery trace.
 */
export function groupShippedUses(shipped: ReadonlyArray<{ path: string; slide: number }>): Array<{ path: string; usedInSlides: number[] }> {
  const bySlide = new Map<string, number[]>();
  for (const { path, slide } of shipped) {
    const normalised = path.replace(/\\/g, "/");
    if (!normalised.startsWith(".media-cache/")) continue;
    const slides = bySlide.get(normalised);
    if (slides === undefined) bySlide.set(normalised, [slide]);
    else if (!slides.includes(slide)) slides.push(slide);
  }
  return [...bySlide].map(([path, usedInSlides]) => ({ path, usedInSlides }));
}
