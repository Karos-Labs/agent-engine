import { z } from "zod";
import { LANDING_SECTION_TAXONOMY, REQUIRED_LANDING_SECTIONS, type LandingSection } from "@agent-engine/tool-karos-landing";

/**
 * The `feedback-round.json` contract (FEEDBACK.md §2) — the client's
 * normalized review feedback for the one permanent rebuild (ENGINE-SPEC
 * §11). Section-addressed, closed `op` vocabulary, `verbatim` always
 * preserved as the audit trail.
 */
export const FeedbackOpSchema = z.enum(["edit", "tone", "reorder", "restyle", "remove", "add", "keep"]);
export type FeedbackOp = z.infer<typeof FeedbackOpSchema>;

export const FeedbackChangeSchema = z.object({
  section: z.string().min(1),
  op: FeedbackOpSchema,
  target: z.string().min(1),
  note: z.string().min(1),
  verbatim: z.string().min(1),
  severity: z.enum(["high", "normal", "low"]).default("normal"),
});
export type FeedbackChange = z.infer<typeof FeedbackChangeSchema>;

export const FeedbackAdditionSchema = z.object({
  section: z.string().min(1),
  reason: z.string().min(1),
  contentHints: z.array(z.string()).default([]),
  afterSection: z.string().optional(),
});
export type FeedbackAddition = z.infer<typeof FeedbackAdditionSchema>;

export const FeedbackRemovalSchema = z.object({
  section: z.string().min(1),
  reason: z.string().min(1),
});
export type FeedbackRemoval = z.infer<typeof FeedbackRemovalSchema>;

export const FeedbackKeepSchema = z.object({
  section: z.string().min(1),
  target: z.string().optional(),
  note: z.string().optional(),
});
export type FeedbackKeep = z.infer<typeof FeedbackKeepSchema>;

export const FeedbackRoundSchema = z.object({
  round: z.number().int().positive(),
  client: z.string().min(1),
  reviewedBuild: z.string().min(1),
  submittedAt: z.string().min(1),
  source: z.string().min(1),
  changes: z.array(FeedbackChangeSchema).default([]),
  additions: z.array(FeedbackAdditionSchema).default([]),
  removals: z.array(FeedbackRemovalSchema).default([]),
  keeps: z.array(FeedbackKeepSchema).default([]),
});
export type FeedbackRound = z.infer<typeof FeedbackRoundSchema>;

export interface OutOfScopeItem {
  kind: "change" | "addition" | "removal";
  item: FeedbackChange | FeedbackAddition | FeedbackRemoval;
  reason: string;
}

export interface ClassifiedFeedback {
  restyles: FeedbackChange[];
  edits: FeedbackChange[];
  reorders: FeedbackChange[];
  additions: FeedbackAddition[];
  removals: FeedbackRemoval[];
  keeps: FeedbackKeep[];
  outOfScope: OutOfScopeItem[];
}

const IDENTITY_RESTYLE_PREFIXES = ["fonts.", "identity.personality", "identity.mood", "tokens.ground"];

function isIdentityChangingRestyle(target: string): string | undefined {
  for (const prefix of IDENTITY_RESTYLE_PREFIXES) {
    if (target === prefix || target.startsWith(prefix)) {
      return `"${target}" is a brand-identity change (fonts / palette intent / ground / personality-mood), not a token value nudge — FEEDBACK.md §3 makes this a fresh build, never an in-scope rebuild delta`;
    }
  }
  return undefined;
}

/**
 * `classifyFeedbackRound` (FEEDBACK.md §3): splits one round's `changes[]`/
 * `additions[]`/`removals[]` into in-scope-for-a-rebuild vs. out-of-scope
 * (a fresh build). Nothing is dropped — every out-of-scope item is returned
 * with its reason, never silently discarded, mirroring the source doc's own
 * "the intake step classifies each request... out-of-scope items are
 * surfaced to the human, never dropped."
 */
export function classifyFeedbackRound(round: FeedbackRound): ClassifiedFeedback {
  const restyles: FeedbackChange[] = [];
  const edits: FeedbackChange[] = [];
  const reorders: FeedbackChange[] = [];
  const outOfScope: OutOfScopeItem[] = [];

  for (const change of round.changes) {
    if (change.op === "restyle") {
      const identityReason = isIdentityChangingRestyle(change.target);
      if (identityReason) {
        outOfScope.push({ kind: "change", item: change, reason: identityReason });
      } else {
        restyles.push(change);
      }
      continue;
    }
    if (change.op === "edit" || change.op === "tone") {
      edits.push(change);
      continue;
    }
    if (change.op === "reorder") {
      reorders.push(change);
      continue;
    }
    // remove/add/keep inside changes[] (the closed vocabulary allows it, though FEEDBACK.md §2's
    // own example only ever uses it via the dedicated additions[]/removals[]/keeps[] arrays) —
    // rather than silently ignoring an op this function doesn't specially handle here, it is
    // conservatively treated as out-of-scope so a human sees it, never silently dropped.
    outOfScope.push({ kind: "change", item: change, reason: `op "${change.op}" inside changes[] is handled via the dedicated additions/removals/keeps arrays, not here — surfaced for manual reconciliation` });
  }

  const additions: FeedbackAddition[] = [];
  for (const addition of round.additions) {
    if (!(LANDING_SECTION_TAXONOMY as readonly string[]).includes(addition.section)) {
      outOfScope.push({
        kind: "addition",
        item: addition,
        reason: `section "${addition.section}" is not in the section taxonomy (ENGINE-SPEC §7) — a new section type needs a new component, which FEEDBACK.md §3 makes a fresh build, not a rebuild`,
      });
      continue;
    }
    additions.push(addition);
  }

  const removals: FeedbackRemoval[] = [];
  for (const removal of round.removals) {
    if ((REQUIRED_LANDING_SECTIONS as readonly string[]).includes(removal.section)) {
      outOfScope.push({
        kind: "removal",
        item: removal,
        reason: `"${removal.section}" is a required section (nav/hero/footer, ENGINE-SPEC §7) and can never be removed`,
      });
      continue;
    }
    removals.push(removal);
  }

  return { restyles, edits, reorders, additions, removals, keeps: round.keeps, outOfScope };
}

export interface DurableBuildState {
  /** The current, ordered section manifest (the `page.tsx` composition — ENGINE-SPEC §7/FEEDBACK.md §1). */
  manifest: LandingSection[];
  /** Per-section content, keyed by taxonomy id — mirrors `LandingCopyOutput.sections`. */
  content: Record<string, unknown>;
}

/** A carry-forward-style hex-value nudge extracted directly from a restyle change's own prose, when present — deliberately never invented: FEEDBACK.md §4 step 2.a resolves a restyle to an actual new token value, but nothing in the round schema carries a structured "new value" field, so the only honest deterministic move is to read one out of the client's own words when they gave one (e.g. "make it #FF5A1A") and leave everything else for a human/an agent step to resolve — silently guessing a color from "make it more orange" is exactly the kind of hallucination this pipeline's typed-outcome discipline exists to prevent. */
export function extractExplicitHexValue(change: FeedbackChange): string | undefined {
  const match = /#[0-9a-fA-F]{6}\b/.exec(`${change.note} ${change.verbatim}`);
  return match?.[0];
}

export interface ApplyStructuralDeltaResult {
  manifest: LandingSection[];
  content: Record<string, unknown>;
  /** Sections whose content was touched by a remove/add — these must be dropped (remove) or freshly copy-drafted (add) by a subsequent COPY re-run; FEEDBACK.md §4 step 3's "touched-set re-copy only" applies on top of this. */
  removedSections: string[];
  addedSections: string[];
  /** Reorder requests this function could not resolve (unknown target syntax, missing section, or a field that isn't an array) — the Deep Parity Audit's finding was that these used to be silently dropped with zero trace; the workflow must surface each of these as an assumption instead. */
  unresolvedReorders: FeedbackChange[];
}

function clampInsertIndex(manifest: readonly LandingSection[], afterSection: string | undefined): number {
  if (!afterSection) return manifest.length - 1; // default: just before footer
  const idx = manifest.indexOf(afterSection as LandingSection);
  if (idx === -1) return Math.max(0, manifest.length - 1);
  return Math.min(idx + 1, manifest.length - 1); // never insert after the last (footer) slot
}

/** The first present of `name`/`label`/`title`/`heading` on an array element — the identifying string a client would actually use to name an item ("move Elite tier first"), across every taxonomy content shape (`OfferingContent.plans[].name`, `FaqContent.faqs[].q`-less items, etc.) without needing a schema per section. */
function elementLabel(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const obj = item as Record<string, unknown>;
  for (const key of ["name", "label", "title", "heading"]) {
    const v = obj[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/**
 * Field-level reordering (FEEDBACK.md §4.2.c: "reorder fields within one
 * section's own content"): `fieldName[]:<comma-separated desired order>`
 * (e.g. `"plans[]:Elite,Pro,Starter"`) reorders `section.fieldName` (an
 * array) to match the given order, matched case-insensitively against each
 * element's own `name`/`label`/`title`/`heading`. Elements not named in the
 * order are appended at the end, in their original relative order — nothing
 * is ever dropped, only reordered. Returns `undefined` if `fieldName` isn't
 * present as an array on this section's content, signaling the caller to
 * treat the request as unresolved rather than silently no-op.
 */
function applyFieldReorder(sectionContent: unknown, fieldName: string, desiredOrder: readonly string[]): Record<string, unknown> | undefined {
  if (!sectionContent || typeof sectionContent !== "object") return undefined;
  const obj = sectionContent as Record<string, unknown>;
  const arr = obj[fieldName];
  if (!Array.isArray(arr)) return undefined;

  const withIndex = arr.map((item, i) => ({ item, label: elementLabel(item)?.toLowerCase(), i }));
  const claimed = new Set<number>();
  const reordered: unknown[] = [];
  for (const wanted of desiredOrder) {
    const match = withIndex.find((w) => !claimed.has(w.i) && w.label === wanted.toLowerCase());
    if (match) {
      claimed.add(match.i);
      reordered.push(match.item);
    }
  }
  for (const w of withIndex) {
    if (!claimed.has(w.i)) reordered.push(w.item);
  }

  return { ...obj, [fieldName]: reordered };
}

const REORDER_AFTER_TARGET = /^after:(.+)$/;
const REORDER_FIELD_TARGET = /^([a-zA-Z0-9_]+)\[\]:(.+)$/;

/**
 * The deterministic half of FEEDBACK.md §4 step 2: structural manifest
 * mutations (`remove` -> `reorder` -> `add`, in that fixed order, per the
 * doc's own ordering — restyle/edit/tone are content-value changes and
 * belong to the COPY re-run, not here) plus field-level array reordering
 * within a section's own content. Two clients who list the same requests in
 * a different order still get the same manifest, because the *application*
 * order is fixed regardless of the round's own list order.
 */
export function applyStructuralDelta(state: DurableBuildState, classified: ClassifiedFeedback): ApplyStructuralDeltaResult {
  let manifest = [...state.manifest];
  const content = { ...state.content };
  const removedSections: string[] = [];
  const addedSections: string[] = [];
  const unresolvedReorders: FeedbackChange[] = [];

  for (const removal of classified.removals) {
    if (manifest.includes(removal.section as LandingSection)) {
      manifest = manifest.filter((s) => s !== removal.section);
      delete content[removal.section];
      removedSections.push(removal.section);
    }
  }

  for (const reorder of classified.reorders) {
    if (reorder.section === "global" || !manifest.includes(reorder.section as LandingSection)) {
      unresolvedReorders.push(reorder);
      continue;
    }

    // Section-level: move where this section sits in the manifest (target names a desired
    // neighbor, e.g. "after:hero").
    const afterMatch = REORDER_AFTER_TARGET.exec(reorder.target);
    if (afterMatch) {
      manifest = manifest.filter((s) => s !== reorder.section);
      const insertAt = clampInsertIndex(manifest, afterMatch[1]);
      manifest.splice(insertAt, 0, reorder.section as LandingSection);
      continue;
    }

    // Field-level: reorder an array field within this section's own content (e.g. pricing tiers).
    const fieldMatch = REORDER_FIELD_TARGET.exec(reorder.target);
    if (fieldMatch) {
      const [, fieldName, orderCsv] = fieldMatch;
      const reorderedSection = applyFieldReorder(content[reorder.section], fieldName!, orderCsv!.split(",").map((s) => s.trim()));
      if (reorderedSection) {
        content[reorder.section] = reorderedSection;
        continue;
      }
    }

    // Neither a recognized section-level nor field-level target syntax, or a field-level target
    // naming something that isn't an array on this section — surfaced, never silently dropped.
    unresolvedReorders.push(reorder);
  }

  for (const addition of classified.additions) {
    if (!manifest.includes(addition.section as LandingSection)) {
      const insertAt = clampInsertIndex(manifest, addition.afterSection);
      manifest.splice(insertAt, 0, addition.section as LandingSection);
      addedSections.push(addition.section);
    }
  }

  return { manifest, content, removedSections, addedSections, unresolvedReorders };
}

export interface KeepSnapshot {
  section: string;
  target: string | undefined;
  valueBefore: unknown;
}

/** FEEDBACK.md §4's FREEZE step, part 1: snapshot every `keep` target's current value before any mutation. */
export function snapshotKeeps(state: DurableBuildState, keeps: readonly FeedbackKeep[]): KeepSnapshot[] {
  return keeps.map((keep) => ({ section: keep.section, target: keep.target, valueBefore: (state.content as Record<string, unknown>)[keep.section] }));
}

export interface FreezeViolation {
  section: string;
  target: string | undefined;
  note: string | undefined;
}

/**
 * FEEDBACK.md §4's FREEZE step, part 2: diff every snapshotted `keep`
 * target against the post-mutation state. A changed frozen field is a
 * violation the workflow must revert and log — "likes are protected" is the
 * single biggest regression guard the whole rebuild contract has.
 */
export function checkKeepsViolated(snapshots: readonly KeepSnapshot[], stateAfter: DurableBuildState): FreezeViolation[] {
  const violations: FreezeViolation[] = [];
  for (const snap of snapshots) {
    const after = (stateAfter.content as Record<string, unknown>)[snap.section];
    if (JSON.stringify(after) !== JSON.stringify(snap.valueBefore)) {
      violations.push({ section: snap.section, target: snap.target, note: undefined });
    }
  }
  return violations;
}

/** Reverts every field a `checkKeepsViolated` violation named, back to its pre-mutation snapshot. */
export function revertFrozenViolations(state: DurableBuildState, snapshots: readonly KeepSnapshot[], violations: readonly FreezeViolation[]): DurableBuildState {
  const content = { ...state.content };
  for (const violation of violations) {
    const snap = snapshots.find((s) => s.section === violation.section);
    if (snap) content[snap.section] = snap.valueBefore;
  }
  return { ...state, content };
}

/** The set of section ids a re-copy (FEEDBACK.md §4 step 3) must cover: every section touched by an edit/tone, every newly added section, plus (defensively) every restyle target's own section when it names one. Untouched sections keep their exact prior copy byte-stable. */
export function touchedSections(classified: ClassifiedFeedback, added: readonly string[]): Set<string> {
  const touched = new Set<string>(added);
  for (const edit of classified.edits) if (edit.section !== "global") touched.add(edit.section);
  for (const restyle of classified.restyles) if (restyle.section !== "global") touched.add(restyle.section);
  return touched;
}
