import type { ActionKind, FixAction, RecOwner } from "@agent-engine/tool-karos-seo-geo";

/**
 * The input this actuator dispatches on (SCRUM-261 / T-A17).
 *
 * `@agent-engine/tool-karos-seo-geo`'s `RoutableRecommendation` **is** the
 * "enriched `FiredRecommendation`" the ticket names — T-A4/SCRUM-257's own
 * enrichment step attaches `fixAction`/`actionKind`/`owner`/`engineProductId?`
 * (plus `check`/`lever`/`productRef`) to every fired row. This actuator does
 * not re-declare that shape; it imports it, so the two tickets can never drift
 * into two different ideas of what a routed recommendation looks like. See
 * `docs/routable-recommendation-contract.md` (C2 / SCRUM-210) for the full
 * cross-repo contract both sides build against.
 */
export type { RoutableRecommendation as SeoFixInput } from "@agent-engine/tool-karos-seo-geo";

/**
 * Why the dispatcher refused to produce an artifact for an otherwise-fired
 * recommendation. Both members are deliberate, generic refusals — neither is
 * keyed on a specific `recId` (see `dispatch.ts`'s module doc).
 */
export type SeoFixRefusalReason =
  /**
   * `rec.fixAction` is not a member of `KNOWN_FIX_ACTIONS`. `FixAction` closes
   * this at the type level, but a `RoutableRecommendation` can arrive here
   * over a wire boundary (queue message, HTTP body) where TypeScript's
   * compile-time guarantee has already been left behind — exactly the same
   * reasoning `rec-routing-map.ts`'s own `routingFor(recId: string)` gives for
   * accepting a bare `string` instead of trusting `CatalogRecId`. Refusing
   * here, rather than falling through a `switch` into `undefined`, is what
   * the acceptance criteria's negative test proves.
   */
  | "unknown_fix_action"
  /**
   * `rec.actionKind === "connect"`: RFC-09 §4 path B — nothing can run until
   * an external account or credential (GSC, GA4, GBP, Bing/BWT, Brave, a
   * connected CMS, …) is connected on the client's behalf, or the fix is a
   * dispatch to another Karos agent that itself needs that connection. This
   * actuator's scope guard (SCRUM-261) is explicit: it never holds a client
   * credential and never reaches a live third-party account, so any record
   * routed `connect` is refused generically — by `actionKind`, never by which
   * `recId` produced it. See the package README / SCRUM-261 report for the
   * full list of `connect`-routed rec_ids this makes currently unreachable
   * from this actuator alone.
   */
  | "requires_external_connection";

export interface SeoFixRefusal {
  readonly ok: false;
  readonly recId: string;
  readonly reason: SeoFixRefusalReason;
  /** Human-readable, safe to log or surface to a caller building on top of this. */
  readonly detail: string;
}

/**
 * One `fixAction`'s generated content. Every variant is a **proposal**, never
 * a value read off (or written to) the client's actual live page — this
 * actuator has no site-fetch and no CMS credential (SCRUM-261 scope guard),
 * so `proposedValue`/`content`/`jsonLd`/`document` are templated off the
 * already-computed `recommendation`/`check` prose, not a diff against
 * anything live. Turning this into a true before/after diff is `cms.previewFix`
 * (RFC-09 §5) — a separate, credentialed tool this ticket does not build.
 */
export type SeoFixProposal =
  | { readonly fixAction: "meta_title"; readonly tag: "title"; readonly proposedValue: string }
  | { readonly fixAction: "meta_description"; readonly tag: 'meta[name="description"]'; readonly proposedValue: string }
  | { readonly fixAction: "og_image"; readonly tag: 'meta[property="og:image"]'; readonly proposedValue: string }
  | { readonly fixAction: "canonical"; readonly tag: 'link[rel="canonical"]'; readonly proposedValue: string }
  | { readonly fixAction: "image_alt"; readonly tag: 'img[alt]'; readonly proposedValue: string }
  | { readonly fixAction: "sitemap"; readonly fileName: "sitemap.xml"; readonly mimeType: "application/xml"; readonly content: string }
  | { readonly fixAction: "schema"; readonly mimeType: "application/ld+json"; readonly jsonLd: Record<string, unknown> }
  | { readonly fixAction: "indexing"; readonly file: "robots.txt"; readonly directive: string }
  /** The advisory fallback (RFC-09 §7's "guided-kit" artifact): a structured hand-off document, never applied by any actuator. */
  | { readonly fixAction: "manual"; readonly kit: "guided-kit"; readonly document: string };

export interface SeoFixArtifact {
  readonly recId: string;
  readonly fixAction: FixAction;
  readonly actionKind: ActionKind;
  readonly owner: RecOwner;
  /** One-line, human-readable statement of what this artifact proposes. */
  readonly summary: string;
  readonly proposal: SeoFixProposal;
  /** ISO-8601. Sourced from an injectable clock so tests are deterministic — see `dispatch.ts`'s `DispatchOptions.now`. */
  readonly generatedAt: string;
}

export interface SeoFixDispatchSuccess {
  readonly ok: true;
  /**
   * A stable, deterministic reference to `artifact` — `<recId>/<fixAction>`,
   * mirroring karos-portal's own `VisibilityGap.artifactRef` field ("Generated
   * fix artifact path — null until the Phase 7 actuator runs"). This package
   * has no storage of its own to write behind that reference (`FiredRecommendation`
   * carries no `clientId`/`runId` to scope a write with, and this ticket does not
   * invent one) — persisting `artifact` for real (e.g. through
   * `@agent-engine/tool-common`'s `WorkspaceStoreLike`, the pattern every other
   * `packages/tools/*` package already uses) is left to whichever caller resolves
   * that scope. See the SCRUM-261 report for why this actuator stops at a pure
   * function rather than inventing that integration point itself.
   */
  readonly artifactRef: string;
  /** Echoed from the input record — this actuator never reclassifies `actionKind`, only acts on it (see `dispatch.ts`). */
  readonly actionKind: ActionKind;
  readonly artifact: SeoFixArtifact;
}

export type SeoFixDispatchOutcome = SeoFixDispatchSuccess | SeoFixRefusal;
