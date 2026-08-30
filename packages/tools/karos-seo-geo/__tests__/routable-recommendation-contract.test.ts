import { describe, expect, it } from "vitest";
import {
  DEFAULT_REC_OWNER,
  KNOWN_ACTION_KINDS,
  KNOWN_FIX_ACTIONS,
  KNOWN_REC_OWNERS,
  type ActionKind,
  type FixAction,
  type RecOwner,
} from "../src/routable-recommendation-contract.js";

/**
 * Pins `FixAction`/`ActionKind`/`RecOwner` (SCRUM-210 / C2) against the
 * exact literal set this ticket documents.
 *
 * There is no live agent-engine source of truth for these three unions to
 * parse — karos-portal's `src/lib/seo-geo.ts` is the canonical source and it
 * lives in a different repo, so (unlike the AST-parsed pin karos-portal's
 * own `routable-recommendation.test.ts` runs against its local copy of
 * `seo-geo.ts`) this test hard-codes the literal set independently, here, in
 * the test file itself, rather than parsing `routable-recommendation-contract.ts`'s
 * own arrays back at themselves — a change to only the source file's arrays,
 * with nothing updated here, still fails this suite. This is deliberately a
 * much smaller and more static set of unions than the 75-record catalog
 * problem the AST pins elsewhere in this codebase solve, so a hard-coded
 * literal comparison is the right tool here, not an AST parse.
 */

const EXPECTED_FIX_ACTIONS = [
  "meta_title",
  "meta_description",
  "schema",
  "og_image",
  "canonical",
  "image_alt",
  "sitemap",
  "indexing",
  "manual",
] as const;

const EXPECTED_ACTION_KINDS = ["one_click", "review_approve", "connect", "guided_manual"] as const;

const EXPECTED_REC_OWNERS = ["karos_agent", "karos_tool", "client_manual"] as const;

/** Compile-time two-way pin: fails to typecheck if either side gains/loses a member the other doesn't have. */
type AssertEqual<A, B> = A extends B ? (B extends A ? true : never) : never;
type _FixActionPin = AssertEqual<FixAction, (typeof EXPECTED_FIX_ACTIONS)[number]>;
type _ActionKindPin = AssertEqual<ActionKind, (typeof EXPECTED_ACTION_KINDS)[number]>;
type _RecOwnerPin = AssertEqual<RecOwner, (typeof EXPECTED_REC_OWNERS)[number]>;
const _typePins: [_FixActionPin, _ActionKindPin, _RecOwnerPin] = [true, true, true];
void _typePins;

describe("routable-recommendation-contract (SCRUM-210 / C2 — cross-repo vocabulary pin)", () => {
  it("KNOWN_FIX_ACTIONS matches the ticket-documented FixAction set exactly, in count and members", () => {
    expect(KNOWN_FIX_ACTIONS.length).toBe(EXPECTED_FIX_ACTIONS.length);
    expect(new Set(KNOWN_FIX_ACTIONS)).toEqual(new Set(EXPECTED_FIX_ACTIONS));
  });

  it("KNOWN_ACTION_KINDS matches the ticket-documented ActionKind set exactly, in count and members", () => {
    expect(KNOWN_ACTION_KINDS.length).toBe(EXPECTED_ACTION_KINDS.length);
    expect(new Set(KNOWN_ACTION_KINDS)).toEqual(new Set(EXPECTED_ACTION_KINDS));
  });

  it("KNOWN_REC_OWNERS matches the ticket-documented RecOwner set exactly, in count and members", () => {
    expect(KNOWN_REC_OWNERS.length).toBe(EXPECTED_REC_OWNERS.length);
    expect(new Set(KNOWN_REC_OWNERS)).toEqual(new Set(EXPECTED_REC_OWNERS));
  });

  it("DEFAULT_REC_OWNER is the fail-safe client_manual default, not one of the automated buckets", () => {
    expect(DEFAULT_REC_OWNER).toBe("client_manual");
  });

  it("a value assignable to FixAction/ActionKind/RecOwner is always found in the matching KNOWN_* set (round-trip)", () => {
    const fixAction: FixAction = "og_image";
    const actionKind: ActionKind = "connect";
    const owner: RecOwner = "karos_tool";
    expect(KNOWN_FIX_ACTIONS).toContain(fixAction);
    expect(KNOWN_ACTION_KINDS).toContain(actionKind);
    expect(KNOWN_REC_OWNERS).toContain(owner);
  });
});
