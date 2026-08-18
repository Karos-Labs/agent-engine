import type { ContentCut, TranscriptWord, VideoSegment } from "@agent-engine/tool-karos-video";

/**
 * `deriveCutSegments` (RFC-06 §2 stage 2 / SKILL.md step 2, PLAYBOOK §3): the
 * deterministic, zero-judgment cut proposal — "CROP THE ENDS, THEN ONLY
 * FILLER." No engine script in `assets/engine/` proposes a cut list (only
 * `cut_check.py` *validates* one), so this is workflow-owned code, not a
 * wrapped Python script; `video.cutGate` remains the authoritative check the
 * workflow calls immediately after.
 *
 * Mirrors `cut_check.py`'s own constants and FILLER vocabulary exactly so a
 * well-formed transcript passes the real gate by construction. A borderline
 * or malformed transcript is expected to occasionally still fail the gate —
 * that failure is surfaced as `WorkflowHeld`, never silently patched, per
 * SKILL.md's "FAIL = fix the cut list, never build borderline."
 */

const MIN_SEGMENT_S = 1.5;
const FILLER_PAD_S = 0.065; // "50/80ms padding" — SKILL.md step 2

/** Verbatim from `cut_check.py`'s `FILLER` set — true disfluencies only, never a real word that merely feels like filler. */
const FILLER = new Set([
  "uh",
  "uhh",
  "uhm",
  "um",
  "umm",
  "er",
  "erm",
  "ah",
  "ahh",
  "eh",
  "mm",
  "mmm",
  "hmm",
  "hm",
  "mhm",
  "uh-huh",
  "euh",
]);

function norm(text: string): string {
  return text.trim().replace(/^[.,!?;:…"']+|[.,!?;:…"']+$/g, "").toLowerCase();
}

export interface CutPlan {
  segments: VideoSegment[];
  contentCuts: ContentCut[];
}

export interface DeriveCutSegmentsOptions {
  /** Caller-declared content cuts with an explicit transcript span — SKILL.md step 6: free text alone is never auto-mapped to a cut. */
  declaredContentCuts?: ContentCut[];
}

/**
 * Builds the kept-segment list from a word-level transcript: crop to the
 * first/last spoken word, then remove only filler-word spans (plus any
 * explicitly declared content cuts), gluing back a filler that would
 * otherwise leave a sub-`MIN_SEGMENT_S` fragment — "leave the smaller filler
 * in rather than minting a sub-1.5s fragment."
 */
export function deriveCutSegments(words: readonly TranscriptWord[], options: DeriveCutSegmentsOptions = {}): CutPlan {
  const spoken = words.filter((w) => w.type === "word" && w.text.trim().length > 0);
  if (spoken.length === 0) {
    return { segments: [], contentCuts: [] };
  }

  const declared = options.declaredContentCuts ?? [];
  const windowStart = spoken[0]!.start;
  const windowEnd = spoken[spoken.length - 1]!.end;

  // Removed spans: filler words (padded) plus declared content cuts, sorted and merged.
  type Span = { start: number; end: number; declared?: ContentCut | undefined };
  const spans: Span[] = [];
  for (const w of spoken) {
    if (FILLER.has(norm(w.text))) {
      spans.push({ start: Math.max(windowStart, w.start - FILLER_PAD_S), end: Math.min(windowEnd, w.end + FILLER_PAD_S) });
    }
  }
  for (const cut of declared) {
    spans.push({ start: cut.span[0], end: cut.span[1], declared: cut });
  }
  spans.sort((a, b) => a.start - b.start);

  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      // Concatenate reasons rather than keeping only the first — two declared
      // cuts merging into one span must never silently drop either reason.
      if (last.declared && span.declared && last.declared !== span.declared) {
        last.declared = { span: [last.start, last.end], reason: `${last.declared.reason}; ${span.declared.reason}` };
      } else {
        last.declared = last.declared ?? span.declared;
      }
    } else {
      merged.push({ ...span });
    }
  }

  // Kept segments = complement of the merged removed spans within the window.
  let segments: VideoSegment[] = [];
  let cursor = windowStart;
  for (const span of merged) {
    if (span.start > cursor) {
      segments.push([cursor, span.start]);
    }
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < windowEnd) {
    segments.push([cursor, windowEnd]);
  }

  // Glue back any sub-MIN_SEGMENT_S fragment into its neighbor rather than shipping a fragment
  // (SKILL.md step 2: "an audible 'uh' costs less than a visible jump cut").
  let changed = true;
  while (changed && segments.length > 1) {
    changed = false;
    for (let i = 0; i < segments.length; i++) {
      const [s, e] = segments[i]!;
      if (e - s < MIN_SEGMENT_S) {
        if (i < segments.length - 1) {
          segments[i] = [s, segments[i + 1]![1]];
          segments.splice(i + 1, 1);
        } else {
          segments[i - 1] = [segments[i - 1]![0], e];
          segments.splice(i, 1);
        }
        changed = true;
        break;
      }
    }
  }

  // Report the merged span's TRUE extent, never the original declared span verbatim: when a
  // declared cut overlaps or abuts a filler span, `segments` above reflects the wider merged
  // removal — cut_check.py's HONESTY check compares the declared span against that same actual
  // gap (`ds <= gs+0.05 and ge-0.05 <= de`), so under-reporting the span here would make an
  // honestly-declared cut look undeclared and fail the real gate for a region that IS accounted for.
  const contentCuts: ContentCut[] = merged
    .filter((span): span is Span & { declared: ContentCut } => span.declared !== undefined)
    .map((span) => ({ span: [span.start, span.end], reason: span.declared.reason }));
  return { segments, contentCuts };
}

/**
 * Total kept runtime across every segment (P1#5 audit fix): `--allow-count`
 * exists for PLAYBOOK §4d point 2's "COUNT ASSUMES A 30s+ RUNTIME" — the
 * workflow previously proxied this off the requested `targetLength` category
 * and the agent's own proposed cutaway count, neither of which is the actual
 * rule and both of which can mask genuine over/undercounting. This is the
 * real number that rule is about.
 */
export function totalRetainedDuration(segments: readonly VideoSegment[]): number {
  return segments.reduce((sum, [s, e]) => sum + (e - s), 0);
}
