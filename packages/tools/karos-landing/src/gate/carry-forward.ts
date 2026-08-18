import { promises as fs } from "node:fs";
import type { CarryForwardItem } from "../types.js";
import type { CarryForwardPlacementFile } from "../generated-paths.js";
import { extractBalancedRegion, violation, type GateViolation } from "./shared.js";

export interface CarryForwardResult {
  violations: GateViolation[];
  total: number;
  missing: string[];
}

const STOPWORDS = new Set(["with", "from", "that", "this", "have", "been", "were", "into", "over", "your", "note", "real", "site", "does"]);

/**
 * The label-separator regex — the boundary between a carry-forward item's
 * short label and its longer descriptive tail (`"Progress-tracking chart -
 * weekly training volume..."` → label `"Progress-tracking chart"`). Includes
 * the em dash (`—`, U+2014) alongside the ASCII hyphen and en dash (`–`,
 * U+2013): the Deep Parity Audit found real fixtures (`thepitch`,
 * `roasthouse`) use em dashes here, which the original two-variant regex
 * silently failed to split on, dragging an entire multi-clause sentence into
 * the fuzzy-word-overlap check instead of just its label.
 */
const LABEL_SEPARATOR = /\s+[-–—]\s+/;

/** Words from a carry-forward label worth searching for — short/common words are dropped, matching FORGE's own component naming being terse, not prose. */
function significantWords(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

/** Escapes a string for safe embedding inside a `RegExp` constructor. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The short label ahead of a carry-forward item's descriptive tail — also used by `agents/landing-builder-agent`'s MAKE step to derive a `CarryForwardWidget.label` for the generated content module, so the gate's notion of "label" and the generator's notion of "label" never drift apart. */
export function carryForwardLabel(item: Pick<CarryForwardItem, "what">): string {
  const label = item.what.split(LABEL_SEPARATOR)[0] ?? item.what;
  return label.trim();
}

function typeTagPattern(type: string): RegExp {
  return new RegExp(`type["']?\\s*:\\s*["'\`]${escapeRegExp(type)}["'\`]`, "i");
}

function fuzzyLabelMatch(item: CarryForwardItem, haystackLower: string): boolean {
  const label = carryForwardLabel(item);
  const words = significantWords(label).length > 0 ? significantWords(label) : significantWords(item.what);
  if (words.length === 0) return true; // nothing meaningful to search for — don't manufacture a false failure
  const matches = words.filter((w) => haystackLower.includes(w)).length;
  const threshold = Math.max(1, Math.ceil(words.length / 2));
  return matches >= threshold;
}

/** Structural type-tag OR fuzzy label-word-overlap, scoped to whatever `text` is handed in. */
function isPresentInText(item: CarryForwardItem, text: string): boolean {
  if (typeTagPattern(item.type).test(text)) return true;
  return fuzzyLabelMatch(item, text.toLowerCase());
}

/**
 * A carry-forward item embedded as a page-level "floating widget" — the
 * real FORGE fixture's own pattern for its chatbot (`page.tsx`:
 * `c.carryForward?.find((w) => w.type === "chatbot")` immediately followed
 * by `{coach && <CoachChatbot .../>}`, never inside any named taxonomy
 * section). Detected as: the item's `type` appears as a quoted string in
 * `pageTsxSource`, with a JSX element tag shortly afterward — a real,
 * text-visible signal that *some* component actually renders conditionally
 * on this type, not just that the type string is mentioned somewhere.
 */
function isPresentAsFloatingWidget(item: CarryForwardItem, pageTsxSource: string | undefined): boolean {
  if (!pageTsxSource) return false;
  const needle = `"${item.type}"`;
  const idx = pageTsxSource.indexOf(needle);
  if (idx === -1) return false;
  const window = pageTsxSource.slice(idx, idx + 300);
  return /<[A-Z]\w*/.test(window);
}

/**
 * The strict carry-forward completeness check (ENGINE-SPEC §3: "the gate
 * fails on a forgotten carry-forward"; RFC-07 task spec: "every entry in
 * `carryForward[]` must exist in the output page, or gate FAILS").
 *
 * Three tiers, tried in order, closing the Deep Parity Audit's finding that
 * the original whole-site-substring-scan shape was defeatable by
 * construction (a workflow could satisfy it with an unconditional,
 * always-true sidecar restating `brand.carryForward` regardless of whether
 * anything was actually built):
 *
 * 1. **Placement-scoped** (`placements`, written by COMPOSE's own
 *    `carryForwardPlacement` decision, read from
 *    `GENERATED_CARRY_FORWARD_PLACEMENT_RELATIVE_PATH`): if this item has a
 *    placement record, the check is scoped to *only that section's own
 *    content region* (`extractBalancedRegion`) — a capability the
 *    deterministic generator never actually authored into that section
 *    correctly fails here, which is the intended, honest behavior.
 * 2. **Floating widget** (`isPresentAsFloatingWidget`): for an item with NO
 *    placement record (COMPOSE decided it belongs to no single section —
 *    a page-level widget instead), require real evidence in `page.tsx` that
 *    something actually renders conditionally on it.
 * 3. **Whole-site fallback** (`allSiteText`): only reached when neither a
 *    placement file nor a floating-widget match exist at all — i.e. a site
 *    this pipeline didn't generate (a hand-authored fixture predating the
 *    placement-file convention, like the real FORGE fixture). Preserves
 *    this check's original, looser behavior for exactly that legacy case,
 *    without reopening the loophole for output *this* pipeline produces
 *    (which always writes a placement file once `carryForward.length > 0`).
 */
export function checkCarryForward(
  carryForward: readonly CarryForwardItem[],
  placements: CarryForwardPlacementFile | undefined,
  contentSource: string | undefined,
  pageTsxSource: string | undefined,
  allSiteText: string | undefined,
  siteRoot: string,
): CarryForwardResult {
  const violations: GateViolation[] = [];
  const missing: string[] = [];
  const wholeSiteFallbackAllowed = !placements; // a placement file exists → this IS pipeline output; no legacy fallback

  for (const item of carryForward) {
    const placement = placements?.find((p) => p.what === item.what);

    if (placement) {
      const regionText = contentSource ? extractBalancedRegion(contentSource, placement.section) : undefined;
      if (regionText && isPresentInText(item, regionText)) continue;
      missing.push(item.what);
      violations.push(
        violation(
          "carry-forward-missing",
          null,
          0,
          `carryForward item "${item.what}" (type: ${item.type}${item.source ? `, source: ${item.source}` : ""}) was placed in section "${placement.section}" but that section's own content shows no evidence of it — the capability was claimed, never actually built`,
          siteRoot,
        ),
      );
      continue;
    }

    if (isPresentAsFloatingWidget(item, pageTsxSource)) continue;

    if (wholeSiteFallbackAllowed && allSiteText && isPresentInText(item, allSiteText)) continue;

    missing.push(item.what);
    violations.push(
      violation(
        "carry-forward-missing",
        null,
        0,
        `carryForward item "${item.what}" (type: ${item.type}) has no section placement, no floating-widget evidence in page.tsx, and no whole-site match — it was never actually built`,
        siteRoot,
      ),
    );
  }

  return { violations, total: carryForward.length, missing };
}

export async function readFileContents(files: readonly string[]): Promise<Map<string, string>> {
  const entries = await Promise.all(files.map(async (f) => [f, await fs.readFile(f, "utf8")] as const));
  return new Map(entries);
}
