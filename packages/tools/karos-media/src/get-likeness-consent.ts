import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";
import { readGeneratedLikenessConsent, type GeneratedLikenessDecision } from "./likeness-consent.js";

// 1.0.0 — new in RFC-16 §5.2 (Instagram Phase 4, concept direction).
const TOOL_VERSION = "1.0.0";

export const GetLikenessConsentInputSchema = z.object({});
export type GetLikenessConsentInput = z.input<typeof GetLikenessConsentInputSchema>;

/** The decision, verbatim. Deliberately the same shape `readGeneratedLikenessConsent` returns, so nothing re-derives it. */
export type GetLikenessConsentResult = GeneratedLikenessDecision;

/**
 * `media.getLikenessConsent` — reads a client's recorded permission for
 * third-party marks and public figures in GENERATED imagery.
 *
 * ## Why a tool at all, rather than a store read at a code step
 *
 * Because there is no store to read from where this is needed. The Instagram
 * workflow holds `templateStore` and `repoRoot` and **no `WorkspaceStore`**
 * (`create-instagram-agent-workflow.ts:477,697,725`), so "just read the
 * document at a free code step" is not reachable. The permission therefore
 * arrives the way `media.getVisualPatterns` does: a registry tool closed over
 * the one client workspace handle this package already keeps.
 *
 * ## Read-only, and no egress of any kind
 *
 * It opens one JSON document in the client's own workspace. No network, no
 * scraper, no model. That is what makes it free to call unconditionally at a
 * step outside the attempt loop, and it is why — unlike
 * `media.ingestVisualPatterns` — there is nothing here for a consent gate to
 * gate.
 *
 * ## Absent tool, absent permit
 *
 * `media.*` is legitimately missing from some registries. A caller that cannot
 * find this tool must treat that as "no permit", which is the conservative
 * default and identical to what a `denied` record produces. Fail-closed by
 * construction rather than by remembering to.
 *
 * ## Why a denial is `success` and not `not_available`
 *
 * A denial is the ANSWER, not the absence of one — and it is the answer for
 * every client in the fleet on day one. The caller needs the `reason` text to
 * put in the run's report so a reviewer can see that the conservative default
 * applied and why. `not_available` would throw that away and make "nobody has
 * a record" indistinguishable from "this deployment has no media tools".
 *
 * ## Ceilings
 *
 * The permit is returned in full, untruncated. `image.generate` accepts at
 * most 6 `permittedMarks` and 3 `permittedFigures` (RFC-16 §5.3) — a caller
 * holding a longer permit must choose which names this run uses rather than
 * have this read silently pick for it.
 */
export function createGetLikenessConsent(store: WorkspaceStoreLike) {
  return defineTool<GetLikenessConsentInput, GetLikenessConsentResult>({
    name: "media.getLikenessConsent",
    description:
      "Reads this client's recorded permission for third-party brand marks and real public figures in GENERATED imagery, from clients/<slug>/client/consent.json. Read-only, no network. Fails closed: an absent record, an unreadable record, an absent generatedLikeness block, a denied or revoked status, and a granted status that names nobody all return granted:false with empty allowlists and the reason a reviewer should see. Never grants a blanket yes — the permit is an explicit list of names an owner wrote.",
    version: TOOL_VERSION,
    inputSchema: GetLikenessConsentInputSchema,
    async execute(_rawInput, { ctx }) {
      // Every failure path inside the reader (including a store read that
      // throws) already resolves to a fail-closed decision, so there is no
      // error branch here to get wrong.
      return success<GetLikenessConsentResult>(await readGeneratedLikenessConsent(store, ctx.clientSlug));
    },
  });
}
