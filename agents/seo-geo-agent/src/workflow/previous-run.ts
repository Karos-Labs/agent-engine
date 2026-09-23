/**
 * WHAT MOVED SINCE LAST TIME.
 *
 * The narrative prompt closes every report with a promise: "the next run will
 * compare against this one". Nothing did. The narrative agent's input carried
 * this run's scores, this run's facts and this run's recommendations, and no
 * trace of any run before it — so four consecutive karoslabs reports opened on
 * the same sentence, ran to the same length and shared most of their wording,
 * because identical inputs produce identical prose and the inputs were
 * identical by construction.
 *
 * That is not a style problem. A client reading their fourth monthly audit
 * wants one thing first: did anything change. A report that cannot say is
 * worth less than a single-line email that can, and a report that reads the
 * same as last month's tells them nothing moved even when something did.
 *
 * The data was already there. Step 20 writes `seoGeoLatestSnapshot` into
 * client memory on every run — the handoff `intel-report-agent` reads. The
 * agent that produced it never read it back.
 *
 * ## Why the comparison has to be computed here
 *
 * The narrative's first rule is never to invent a number, enforced by
 * `gate.numbersSourced` against a list of values the workflow computed. A
 * model handed two scores and asked for the difference is doing arithmetic and
 * presenting the result as given, which that rule forbids for good reason. So
 * the delta is computed in code, handed over as a value, and added to the
 * gate's sources — the same shape as every other number in the summary.
 */

/** The fields of a `seoGeoLatestSnapshot` this comparison needs. Everything else in that record is for other readers. */
export interface SeoGeoPreviousRun {
  runId: string;
  recordedAt: string;
  seoScore: number;
  seoDataCoveragePct: number;
  geoReadinessScore: number;
  geoDataCoveragePct: number;
  visibilityIndex: number | null;
}

/** This run's own numbers, in the shape the comparison needs. */
export interface SeoGeoCurrentRun {
  seoScore: number;
  seoDataCoveragePct: number;
  geoReadinessScore: number;
  geoDataCoveragePct: number;
  visibilityIndex: number | null;
}

export interface SeoGeoMovement {
  previous: SeoGeoPreviousRun;
  /** Positive means the score went up. */
  seoDelta: number;
  geoDelta: number;
  /** Null when either run has no visibility index — an absent measurement is not a movement of zero. */
  visibilityDelta: number | null;
  /** Every score identical to last run's. */
  unchanged: boolean;
  /**
   * The two runs measured different shares of their checks, so a score delta
   * is NOT like-for-like: the score counts an unmeasured check as zero, so
   * connecting Search Console between runs raises the score without the site
   * changing at all. Stated rather than silently narrated as an improvement.
   */
  coverageChanged: boolean;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The previous run's snapshot out of the beliefs record, or undefined.
 *
 * Undefined for a first-ever run, for a belief written by an older version
 * without these fields, and — deliberately — for a snapshot this very run
 * wrote. A resumed run replays its steps; without the runId check a resume
 * after step 20 would compare a run against itself and report that nothing
 * moved, which is true and useless.
 */
export function readPreviousRun(beliefs: Record<string, unknown>, currentRunId: string): SeoGeoPreviousRun | undefined {
  const raw = beliefs["seoGeoLatestSnapshot"];
  if (raw === null || typeof raw !== "object") return undefined;
  const snapshot = raw as Record<string, unknown>;
  const runId = typeof snapshot["runId"] === "string" ? snapshot["runId"] : undefined;
  if (runId === undefined || runId === currentRunId) return undefined;
  const recordedAt = typeof snapshot["recordedAt"] === "string" ? snapshot["recordedAt"] : undefined;
  const seoScore = finiteNumber(snapshot["seoScore"]);
  const geoReadinessScore = finiteNumber(snapshot["geoReadinessScore"]);
  if (recordedAt === undefined || seoScore === undefined || geoReadinessScore === undefined) return undefined;
  return {
    runId,
    recordedAt,
    seoScore,
    seoDataCoveragePct: finiteNumber(snapshot["seoDataCoveragePct"]) ?? 0,
    geoReadinessScore,
    geoDataCoveragePct: finiteNumber(snapshot["geoDataCoveragePct"]) ?? 0,
    visibilityIndex: finiteNumber(snapshot["visibilityIndex"]) ?? null,
  };
}

export function scoreMovement(previous: SeoGeoPreviousRun, current: SeoGeoCurrentRun): SeoGeoMovement {
  const seoDelta = current.seoScore - previous.seoScore;
  const geoDelta = current.geoReadinessScore - previous.geoReadinessScore;
  const visibilityDelta =
    previous.visibilityIndex !== null && current.visibilityIndex !== null
      ? current.visibilityIndex - previous.visibilityIndex
      : null;
  return {
    previous,
    seoDelta,
    geoDelta,
    visibilityDelta,
    unchanged: seoDelta === 0 && geoDelta === 0 && (visibilityDelta === null || visibilityDelta === 0),
    coverageChanged:
      Math.round(previous.seoDataCoveragePct) !== Math.round(current.seoDataCoveragePct) ||
      Math.round(previous.geoDataCoveragePct) !== Math.round(current.geoDataCoveragePct),
  };
}

/** `2026-09-15T12:08:11.004Z` → `15 September 2026`. The client reads a date, not a timestamp. */
function readableDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function signed(delta: number): string {
  return delta > 0 ? `up ${delta}` : delta < 0 ? `down ${Math.abs(delta)}` : "unchanged";
}

/**
 * The craft directive the narrative opens on.
 *
 * States the movement as a finished sentence the model may use verbatim,
 * because the alternative — describing the movement and letting the model
 * phrase it — is how "up 4" becomes "a meaningful improvement". The one thing
 * it must never do is dress up a flat month: `unchanged` says so plainly, and
 * a summary that opens "nothing moved since 15 September" is more useful than
 * the same four sentences the client already read.
 */
export function movementDirective(movement: SeoGeoMovement | undefined): string | undefined {
  if (movement === undefined) {
    return (
      "This is the FIRST measured run for this client, so there is nothing to compare against. " +
      "Say so in the opening sentence — it sets the baseline the next run will be read against — " +
      "and do not imply any trend, improvement or decline."
    );
  }
  const since = readableDate(movement.previous.recordedAt);
  if (movement.unchanged) {
    return (
      `OPEN ON THE COMPARISON: every score is identical to the previous run on ${since}. ` +
      "Say that plainly in the first sentence — a flat month is a finding, and the client has already read " +
      "these numbers once. Then spend the summary on what would move them, not on restating the scores. " +
      "Do not manufacture a change, a trend or a note of progress that the numbers do not show."
    );
  }
  const parts = [
    `SEO ${signed(movement.seoDelta)}`,
    `GEO Readiness ${signed(movement.geoDelta)}`,
    ...(movement.visibilityDelta !== null ? [`AI visibility index ${signed(movement.visibilityDelta)}`] : []),
  ];
  return (
    `OPEN ON THE COMPARISON with the previous run on ${since}: ${parts.join(", ")}. ` +
    "Lead with what moved, then the current scores and their coverage as usual. " +
    (movement.coverageChanged
      ? "IMPORTANT: the two runs measured DIFFERENT shares of their checks, so this is not a like-for-like comparison — " +
        "the score counts an unmeasured check as zero, so connecting a data source raises it without the site changing. " +
        "Say so in the same breath as the movement; never present it as the site having improved."
      : "Both runs measured the same share of their checks, so the movement is a like-for-like comparison.")
  );
}

/**
 * The figures the movement introduces, for `gate.numbersSourced`.
 *
 * Without these the gate refuses the very sentence this feature exists to
 * produce: a delta is a number the model was handed, but it appears in no
 * other source list, and the gate cannot tell the difference between a value
 * given and a value invented.
 */
export function movementSources(movement: SeoGeoMovement | undefined): string[] {
  if (movement === undefined) return [];
  const magnitudes = [Math.abs(movement.seoDelta), Math.abs(movement.geoDelta)];
  if (movement.visibilityDelta !== null) magnitudes.push(Math.abs(movement.visibilityDelta));
  return [
    `${movement.previous.seoScore}`,
    `${movement.previous.seoScore}%`,
    `${movement.previous.geoReadinessScore}`,
    `${movement.previous.geoReadinessScore}%`,
    `${Math.round(movement.previous.seoDataCoveragePct)}%`,
    `${Math.round(movement.previous.geoDataCoveragePct)}%`,
    ...(movement.previous.visibilityIndex !== null ? [`${movement.previous.visibilityIndex}`] : []),
    ...magnitudes.map((n) => `${n}`),
  ];
}
