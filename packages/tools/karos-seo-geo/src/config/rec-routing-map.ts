/**
 * The 75-row `rec_id -> {fixAction, actionKind, owner, engineProductId?}` routing
 * table for `rec-catalog.data.ts` (T-A4 / SCRUM-257; ratified by SCRUM-333
 * decision 22, 2026-08-28).
 *
 * This is the file `docs/routable-recommendation-contract.md` §"Where the
 * mapping table itself lives" reserves: *"The table lands beside
 * `rec-catalog.data.ts` (`packages/tools/karos-seo-geo/src/config/`), in
 * whatever file T-A4 picks."* The portal consumes it through `recommend.ts`'s
 * output and keeps no copy.
 *
 * Unlike its `*.data.ts` neighbours in this directory, this file is NOT a port
 * of a karos-agents JSON asset — there is no upstream artifact to transcribe.
 * Every row is a hand-made reading of that catalog record's own `product_ref`,
 * `product`, `check` and `lever` fields against the three contract unions,
 * which is why each row carries its reasoning inline. Hence the `-map.ts`
 * suffix rather than `.data.ts`.
 *
 * ## How each column was decided
 *
 * `fixAction` — which of `FixAction`'s eight machine-appliable types this
 * record's fix actually *is*; `"manual"` where it is none of them (most
 * content, off-site and measurement records). Two near-misses worth naming,
 * because the near-miss is the whole risk here: `canonical` means
 * `rel=canonical` (BOTH-07), NOT GEO-37's "canonical entity profile"; and
 * `sitemap` means an XML sitemap (BOTH-09), NOT GEO-40's `llms.txt`.
 *
 * `actionKind` — RFC-09 §1's own four definitions, applied per record:
 *   - `one_click`      — "both agent-direct (we generate it) and in
 *                         MACHINE_APPLIABLE". RFC-09 §3 is emphatic that this
 *                         still means "one click to APPROVE a fix we already
 *                         prepared", never "silently goes live" — so it is
 *                         used only where the generated artifact is
 *                         unambiguous and a wrong one is cheap to undo.
 *   - `review_approve` — we draft it, a human reads it before it ships.
 *   - `connect`        — nothing can run until an external account or
 *                        credential is connected (GSC, GA4, GBP, Bing/BWT,
 *                        Brave, a pinned backlink-vendor export, LinkedIn,
 *                        Reddit), or the fix is RFC-09 path-B dispatch to
 *                        another Karos agent.
 *   - `guided_manual`  — advisory: we hand over a kit, the client (or their
 *                        developer or PR team) ships it.
 *
 * `owner` — the three-way split, drawn on *who performs the fix*, never on who
 * measured the gap:
 *   - `karos_agent`   — a run of a named engine product produces and ships it.
 *                       Carries that product's `engineProductId`.
 *   - `karos_tool`    — a deterministic tool/connector/dashboard leg does it
 *                       (ingestion, monitoring, scoring, reporting): no agent
 *                       drafting, and nothing for the client to do either.
 *   - `client_manual` — the client, their developer, or their PR/reviews team
 *                       does it. The contract's fail-safe default.
 *
 * ## Rule 3 is enforced by the type, not by a convention
 *
 * `RecRouting` is discriminated on `owner`: `karos_agent` REQUIRES an
 * `engineProductId`, and the other two owners forbid one (`?: never`). So
 * contract Rule 3 — *"`owner === "karos_agent"` without a valid
 * `engineProductId` is a build error on the side that owns the mapping
 * table"* — is a real `tsc` error here rather than a runtime fallback, and the
 * contract's *"only present, and only trusted, when `owner === "karos_agent"`"*
 * holds in the other direction too. Rule 2's other half (the id must be a live
 * `KNOWN_PRODUCT_IDS` member) is pinned by `__tests__/rec-routing-map.test.ts`,
 * which reads `apps/agent-server/src/wiring/workflows.ts` as text rather than
 * importing it: an app-to-package import would invert the dependency graph,
 * and this package does not depend on `@agent-engine/agent-server`.
 *
 * Contract Rule 1 — *"`product_ref.folder` is a lab folder name, NOT an engine
 * `productId`; the mapping is manual and reviewed, never derived automatically
 * from a folder name string"* — is why BOTH-08 carries no `engineProductId`
 * even though its `product_ref.folder` is `"landing-page"` and this repo ships
 * a `landing-builder-agent`. See that row's note.
 */
import type { ActionKind, FixAction, RecOwner } from "../routable-recommendation-contract.js";
import { recCatalogData } from "./rec-catalog.data.js";

/** Every `rec_id` in `rec-catalog.data.ts`, as a literal union — so an unmapped catalog row is a `tsc` error below. */
export type CatalogRecId = keyof typeof recCatalogData;

/**
 * The engine products this table routes to — a hand-checked subset of
 * `KNOWN_PRODUCT_IDS` (`apps/agent-server/src/wiring/workflows.ts`), restated
 * here rather than imported because a tool package importing an app would
 * invert the dependency graph. `__tests__/rec-routing-map.test.ts` pins this
 * list against that file's live literal, so a rename there fails a test here.
 */
export const SEO_GEO_ENGINE_PRODUCT_IDS = ["seo-geo-agent", "blog-agent", "linkedin-agent", "reddit-agent"] as const;
export type SeoGeoEngineProductId = (typeof SEO_GEO_ENGINE_PRODUCT_IDS)[number];

/**
 * One routing row. Discriminated on `owner` so contract Rule 3 is a compile
 * error rather than a code review question.
 */
export type RecRouting =
  | {
      readonly fixAction: FixAction;
      readonly actionKind: ActionKind;
      readonly owner: "karos_agent";
      readonly engineProductId: SeoGeoEngineProductId;
    }
  | {
      readonly fixAction: FixAction;
      readonly actionKind: ActionKind;
      readonly owner: Exclude<RecOwner, "karos_agent">;
      readonly engineProductId?: never;
    };

/**
 * The table. `satisfies Record<CatalogRecId, RecRouting>` is the coverage gate:
 * a catalog row added without a row here is a missing-property `tsc` error, and
 * a row here for a `rec_id` the catalog does not have is an excess-property
 * `tsc` error. `__tests__/rec-routing-map.test.ts` asserts both directions at
 * runtime as well, because `vitest` does not typecheck.
 *
 * Rows are in catalog order, so this file diffs against `rec-catalog.data.ts`
 * by eye.
 */
export const REC_ROUTING = {
  // Roll-up of the whole SEO score, not a page-level fix: a3's scoring tool computes it and a human
  // reads the number before it reaches the client. Nothing here for the client to action.
  "SEO-01": { fixAction: "manual", actionKind: "review_approve", owner: "karos_tool" },

  // a3 detects the cannibalization/thin clusters; the remedy is an editorial merge-or-expand plan the
  // seo-geo-agent drafts. Which of two overlapping pages survives is a human call, so not one_click.
  "BOTH-06": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // The archetypal machine-appliable fix: a regenerated `<title>` string, diffed before it ships.
  "SEO-02": { fixAction: "meta_title", actionKind: "one_click", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // "Measurement = a3/i2 + GSC": the branded-impressions leg cannot be read at all without a verified
  // GSC property, and the drivers the record names (a1/a2 ads, content) are other products' work.
  "GEO-30": { fixAction: "manual", actionKind: "connect", owner: "karos_tool" },

  // Fires when no Knowledge Panel renders. Its own `source` points at Organization structured data, so
  // the actionable leg is emitting/repairing Organization schema — but brand identity facts must be
  // confirmed by a human before we assert them in JSON-LD.
  "SEO-03": { fixAction: "schema", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // a3's lighthouse-audit measures; fixing LCP/INP/CLS is front-end and hosting engineering on the
  // client's stack. Deliberately not `connect`: the record's own data_source_ladder adds a free lab
  // tier, so a connected Google is preferred but never required.
  "SEO-04": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // Viewport, responsive parity and horizontal-scroll defects are front-end work in the client's templates.
  "BOTH-19": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // Certificates, HTTP->HTTPS redirects and mixed content are hosting/server configuration.
  "BOTH-20": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // Soft-404s, redirect chains and parameter sprawl are server/CMS routing changes: a3 produces the
  // crawl export that proves them, the client's developer ships the fix.
  "SEO-05": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // Generated `<meta name="description">` copy — machine-appliable and agent-direct.
  "SEO-06": { fixAction: "meta_description", actionKind: "one_click", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // backlink-analyzer's editorial-ratio read is computed off a pinned vendor backlink export: with no
  // connected dataset there is no number at all, and raising the ratio is off-site earned work.
  "BOTH-15": { fixAction: "manual", actionKind: "connect", owner: "karos_tool" },

  // Keyword density and one-primary-intent-per-URL are body-copy rewrites, none of the eight.
  "BOTH-21": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // NOT `canonical`: the fix is restructuring URLs, not setting rel=canonical. A URL change drags
  // redirects and link equity with it, so the agent proposes the map and a human approves it.
  "SEO-07": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Generated descriptive alt attributes: machine-appliable, agent-direct, and cheap to undo.
  "SEO-08": { fixAction: "image_alt", actionKind: "one_click", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // A velocity monitor over a pinned backlink export plus alert-manager — a connector's job, dead
  // without that connected export. No fix ships from it; it raises an alert.
  "SEO-09": { fixAction: "manual", actionKind: "connect", owner: "karos_tool" },

  // Same connector and same dependency as SEO-09, watching spam-category influx instead.
  "SEO-10": { fixAction: "manual", actionKind: "connect", owner: "karos_tool" },

  // A join of rank-tracker and geo-monitor over a frozen SERP/answer snapshot: an analysis Karos
  // produces and a human interprets. There is no per-page fix to apply.
  "BOTH-17": { fixAction: "manual", actionKind: "review_approve", owner: "karos_tool" },

  // Exactly `indexing`: a stray `noindex`/`nosnippet` on a key URL. NOT one_click despite being
  // machine-appliable — some pages are noindexed on purpose, and indexing a staging or private URL is
  // the harmful direction, so a human confirms the page was meant to be indexable. (Its X-Robots-Tag
  // leg is a server header we cannot write at all.)
  "BOTH-01": { fixAction: "indexing", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Also `indexing`, but the failing leg is a login wall or paywall. Removing one is a decision about
  // the client's revenue model; Karos must never take it on their behalf.
  "BOTH-02": { fixAction: "indexing", actionKind: "guided_manual", owner: "client_manual" },

  // robots.txt crawler access, but its GSC leg ("Generative-AI opt-out toggle == OFF") is explicitly
  // "blocked on GSC_SERVICE_ACCOUNT_KEY/GSC_SITE_URL", so the rec cannot be closed out end to end
  // until that property is connected. Contrast GEO-10: the same robots.txt check with no GSC leg.
  "GEO-01": { fixAction: "indexing", actionKind: "connect", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Rewriting a section's opening block into a 40-60 word self-contained capsule: generated prose.
  "GEO-02": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Adding statistics, quotations and cited sources — factual claims, so a human checks them.
  "GEO-03": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // "Unique, non-commodity content with a POV" is the one thing a generator cannot be trusted to
  // produce unreviewed: the entire point of the check is that the page must not read as commodity.
  "BOTH-03": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // The OAI-SearchBot robots.txt leg (indexing) plus a Bing `site:`/BWT URL-inspection leg that needs
  // a connected Bing Webmaster property to read.
  "GEO-08": { fixAction: "indexing", actionKind: "connect", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Pure robots.txt: four crawler Disallow bools, no external account anywhere in the check. The
  // generated diff is four lines and unambiguous, so this is the one crawler-access row that is one_click.
  "GEO-10": { fixAction: "indexing", actionKind: "one_click", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Citation density, a named byline and an original statistic: generated content plus a real author
  // attribution, both of which need reading before they ship.
  "GEO-09": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Share-of-model measurement over a frozen captured response set: a dashboard number Karos produces.
  // Nothing is applied to the client's site and nothing is left for the client to do.
  "GEO-11": { fixAction: "manual", actionKind: "review_approve", owner: "karos_tool" },

  // The GEO score itself — the same roll-up character as SEO-01.
  "GEO-12": { fixAction: "manual", actionKind: "review_approve", owner: "karos_tool" },

  // H1 count and heading-level skips are template/markup edits and the question-phrasing leg is
  // copywriting. Neither is one of the eight — `meta_title` is the title tag, not the H1.
  "GEO-17": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Entity density with definitional sentences under an anti-stuffing ceiling: generated prose that can
  // overshoot into stuffing (the record's own source prices that at -8%), so it gets read first.
  "GEO-18": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // The internal-link graph (bidirectional pillar links, orphans, click depth, anchor text): the agent
  // can draft the whole link map, but it rewires site navigation, so a human approves it.
  "BOTH-05": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // a3 audits and flags; the fix is net-new original images and video. The record names "e6 Motion /
  // YouTube GEO Agent" as the producer, which is not a KNOWN_PRODUCT_IDS product — per Rule 1 no
  // engineProductId is invented for it, and asset production stays with the client.
  "GEO-19": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // product_ref is e14/blog-agent/live and this repo ships a `blog-agent`: RFC-09 path B verbatim —
  // "a content brief dispatched to the Blog or LinkedIn agent" — gated on the blog/CMS connection.
  "GEO-20": { fixAction: "manual", actionKind: "connect", owner: "karos_agent", engineProductId: "blog-agent" },

  // content-gap-analysis + geo-content: the agent drafts the missing sub-intent sections.
  "GEO-21": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Question-form H2/H3 with short crawlable prose answers — generated copy, and deliberately NOT
  // `schema`: the record's own caveat is that the value is on-page text, not FAQ markup.
  "GEO-22": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // The check's own agent-direct leg is "Author Person JSON-LD emitted agent-direct", so the fix type
  // is `schema`. Not one_click: the failing condition is an anonymous page, and emitting a Person
  // entity asserts a real named human's credentials — a human names that person.
  "BOTH-04": { fixAction: "schema", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // product_ref null, delivery advisory: soliciting real reviews on G2/Trustpilot/Google is the
  // client's programme, and the FTC Fake Reviews Rule guard in the check is exactly why Karos must
  // not automate it.
  "GEO-14": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // Wikipedia notability is decided by Wikipedia's editors, not by us — the record's own source notes
  // the page is removed when notability is not met. Advisory, product_ref null.
  "GEO-15": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // product_ref e15/reddit-agent, and this repo ships a `reddit-agent`, so the fix is dispatchable —
  // gated on a connected Reddit account. The catalog's own status is "building" while
  // KNOWN_PRODUCT_IDS lists reddit-agent as dispatchable; `connect` is right either way, because the
  // connect flow is what surfaces a not-yet-available target instead of silently running nothing.
  "GEO-16": { fixAction: "manual", actionKind: "connect", owner: "karos_agent", engineProductId: "reddit-agent" },

  // The same Wikipedia/Wikidata eligibility ground as GEO-15 with the Wikidata leg added. product_ref null.
  "GEO-25": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // The named product is a "Digital-PR / Earned-Mention Agent" that does not exist in this engine.
  // Earning unlinked mentions on DR>=40 domains is human PR work, and the check's own authenticity
  // guard bans paid placements. a3 measures the count; nobody here automates the fix.
  "GEO-04": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // Editorial earned-media placements, non-paid and non-wire-only: pitching journalists. product_ref null.
  "GEO-06": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // Producing owned YouTube videos with brand-bearing titles and transcripts. product_ref null and the
  // named "YouTube GEO Agent" is not a KNOWN_PRODUCT_IDS product, so nothing is routed to one.
  "GEO-05": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // Same Digital-PR / Earned-Mention ground as GEO-04, counted across a fixed co-citation source set.
  "GEO-13": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // Getting named in third-party "best of" roundups is outreach to other publishers, and the check
  // itself says to avoid pay-for-placement. The owned mirror of this is GEO-NEW-02, which we do run.
  "BOTH-10": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // The owned leg BOTH-10 lacks: a3's geo-content drafts our own comparison/"vs"/alternatives pages,
  // including the comparison table and verdict capsule. Claims about named competitors get reviewed.
  "GEO-NEW-02": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // "Reproducible via GBP API", and the first leg is "GBP claimed + verified" — nothing can be read or
  // changed before that connection exists. A connector's job, not an agent run.
  "BOTH-NEW-01": { fixAction: "manual", actionKind: "connect", owner: "karos_tool" },

  // Ghost-citation gap: two string-match ratios over the frozen response set. A dashboard metric.
  "GEO-26": { fixAction: "manual", actionKind: "review_approve", owner: "karos_tool" },

  // first_position_rate is a deterministic ordinal read of the frozen answer set — measurement only.
  "BOTH-14": { fixAction: "manual", actionKind: "review_approve", owner: "karos_tool" },

  // Share of voice against a locked competitor set: the same dashboard, a different denominator.
  "GEO-27": { fixAction: "manual", actionKind: "review_approve", owner: "karos_tool" },

  // The textbook `connect` row: the check is GSC API ingestion and the record says outright it is
  // "Blocked on GSC_SERVICE_ACCOUNT_KEY/GSC_SITE_URL".
  "GEO-28": { fixAction: "manual", actionKind: "connect", owner: "karos_tool" },

  // GA4 ingestion with a source-matching regex plus UTM tagging: dead until GA4 is connected.
  "GEO-29": { fixAction: "manual", actionKind: "connect", owner: "karos_tool" },

  // First-hand experience markers and original data — by definition things only the client has lived
  // or measured. The agent can shape them, but it cannot invent them, so a human supplies and reads them.
  "BOTH-11": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Brave indexation is an `indexing` question (Claude's web search rides on Brave), and reading Brave
  // rank/indexation needs the Brave Search API key wired up. Position is captured as a datapoint, not
  // a gate, so there is no drafted artifact here — a monitoring leg, not an agent run.
  "GEO-23": { fixAction: "indexing", actionKind: "connect", owner: "karos_tool" },

  // IndexNow key file plus Bing submission — RFC-09 §5's own `search.requestIndexing`, named there as
  // "the lowest-risk actuator, worth building and shipping first". A tool/connector submits URLs; it
  // needs the Bing Webmaster property and the IndexNow key in place first.
  "GEO-24": { fixAction: "indexing", actionKind: "connect", owner: "karos_tool" },

  // A composite whose content legs (capsule, entity density, fan-out) the agent drafts, but two of its
  // five legs — Google index status and the GSC AI-features opt-out toggle — cannot be read or changed
  // without a connected Google property, so the rec is not actionable end to end until that lands.
  "GEO-41": { fixAction: "manual", actionKind: "connect", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Exactly `canonical`: rel=canonical validity and self-reference. Not one_click, because its third
  // leg ("single canonical host enforced via 301") is a server/DNS change we cannot ship at all — a
  // one-click that silently fixes two legs of three would misreport itself as done.
  "BOTH-07": { fixAction: "canonical", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Rule 1's worked example. product_ref.folder is "landing-page" and this repo ships a
  // `landing-builder-agent` — but that agent builds OUR landing pages behind a write-fence, it does not
  // server-render a client's existing JS app. The record's own text says the implementer is "s6 Website
  // Redesign — roadmap/unbuilt". So: no engineProductId derived from the folder name, and the rebuild
  // stays with the client's developers. a3 only diagnoses.
  "BOTH-08": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // Exactly `sitemap`, and the safest of the eight: a generated XML sitemap plus a `Sitemap:` line in
  // robots.txt, both derivable from the crawl with no judgement call and trivially revertible. The one
  // existing-product row that earns one_click, on RFC-09 §1's "we generate it" reading of agent-direct.
  "BOTH-09": { fixAction: "sitemap", actionKind: "one_click", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Organization JSON-LD with sameAs and a stable @id: generated structured data, machine-appliable,
  // agent-direct. The record scopes itself to entity/rich-result hygiene, so the blast radius is small.
  "BOTH-12": { fixAction: "schema", actionKind: "one_click", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Creating and sourcing a Wikidata item is a third-party wiki edit under someone else's notability
  // and sourcing rules. The record's own product is "a11 Wikipedia Page Creation (**catalog, not
  // built**)" — no engine product exists for it, whatever product_ref says.
  "GEO-07": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // Named brand-mention rate across the five engines — the same frozen-snapshot dashboard family.
  "GEO-35": { fixAction: "manual", actionKind: "review_approve", owner: "karos_tool" },

  // The frozen-input contract is internal engine discipline: hashes and a scoring-weights version
  // stored per run. Karos's own tooling either holds the invariant or it does not.
  "BOTH-18": { fixAction: "manual", actionKind: "review_approve", owner: "karos_tool" },

  // product_ref e10/linkedin-agent/live, and this repo ships a `linkedin-agent`: RFC-09 path B's other
  // named example. Posting needs the LinkedIn account connected. The record's own named-expert leg is
  // explicitly "agent-direct/human, not the brand Agent" — the brand-account leg is what routes here.
  "GEO-31": { fixAction: "manual", actionKind: "connect", owner: "karos_agent", engineProductId: "linkedin-agent" },

  // Net sentiment from a frozen-lexicon classifier over cached labels: a measurement, and one whose own
  // check insists re-runs read cached labels rather than re-classifying.
  "GEO-32": { fixAction: "manual", actionKind: "review_approve", owner: "karos_tool" },

  // Two legs: a Wikidata description (third party) and >=2 disambiguating attributes in our own schema.
  // The fix type is the schema half; the Wikidata half keeps it out of one_click.
  "GEO-34": { fixAction: "schema", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Stored per-engine baseline constants, refreshed quarterly, divided into the client's share. Pure
  // measurement configuration.
  "GEO-36": { fixAction: "manual", actionKind: "review_approve", owner: "karos_tool" },

  // "Canonical entity profile" is the brand's about/entity page, NOT rel=canonical — the fix is a
  // genuine content refresh, so `manual`, not `canonical`. GEO-20's sibling check explicitly blocks
  // date-only edits, which is why this cannot be a one-click dateModified bump.
  "GEO-37": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // >=50 indexed original articles with no 30-day publishing gap: sustained publishing, dispatched to
  // the blog agent per product_ref e14/blog-agent/live, gated on the blog/CMS connection.
  "BOTH-13": { fixAction: "manual", actionKind: "connect", owner: "karos_agent", engineProductId: "blog-agent" },

  // Section sizing, question-form H2s, a short definition and a Flesch floor: all copy edits the agent
  // drafts and a human reads.
  "BOTH-16": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Conversational/long-tail coverage against a frozen query list — a3's geo-content drafts the answers.
  "GEO-NEW-04": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // Quora and vertical forums, product_ref null, delivery advisory: the record's product is the Reddit
  // agent "extended to forums/Quora", an extension that does not exist. The disclosure guard is the
  // same reason GEO-14 stays manual — an undisclosed brand answer is the failure mode.
  "GEO-33": { fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" },

  // Merging under-40-word sections back into sized units: a structural copy edit.
  "GEO-38": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // The fix type is `schema` (validate the emitted JSON-LD, drop types with no visible equivalent), but
  // this record is an anti-pattern guard whose last leg is a policy gate — "no new schema justified
  // solely on an AI-ranking rationale". A policy judgement is not machine-appliable, so review_approve.
  "GEO-39": { fixAction: "schema", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // `llms.txt` is NOT `sitemap` — a different file with a different consumer, and the record weights it
  // 0 in any ranking score. The agent can generate one, but shipping a file that Google has said carries
  // no benefit is a judgement call the client should see before it lands.
  "GEO-40": { fixAction: "manual", actionKind: "review_approve", owner: "karos_agent", engineProductId: "seo-geo-agent" },

  // SCRUM-382: the first (and, as of this row, only) catalog record that maps to `og_image` — see
  // rec-catalog.data.ts's "SEO-11" header note for why this record exists at all. Same shape as its
  // sibling meta-tag rows: a single `<meta property="og:image">` value the agent drafts off an
  // existing site asset, diffed before it ships — the same "generated, cheap-to-undo tag value"
  // reasoning SEO-02 (title) and SEO-06 (description) already use, so one_click follows their precedent.
  "SEO-11": { fixAction: "og_image", actionKind: "one_click", owner: "karos_agent", engineProductId: "seo-geo-agent" },
} as const satisfies Record<CatalogRecId, RecRouting>;

/** Every `rec_id` this table routes. Identical to `CatalogRecId` by construction — the `satisfies` above is what makes that true. */
export type RoutedRecId = keyof typeof REC_ROUTING;

/**
 * The contract's fail-safe row, for a `rec_id` this table does not know.
 * `tsc` and `__tests__/rec-routing-map.test.ts` both make an unmapped catalog
 * row impossible, so this is unreachable for catalog ids — it exists because
 * `evaluateRecommendations` takes `Record<string, ...>` and a caller can hand
 * it any string. Per the contract: `"manual"` / `"guided_manual"` /
 * `client_manual`, never silently promoted to something the platform runs on
 * its own. `__tests__/rec-routing-map.test.ts` pins `owner` here against
 * `DEFAULT_REC_OWNER`, so the two cannot drift apart.
 */
export const FAIL_SAFE_ROUTING: RecRouting = {
  fixAction: "manual",
  actionKind: "guided_manual",
  owner: "client_manual",
};

/** Routing for a `rec_id`, falling back to `FAIL_SAFE_ROUTING` for anything not in the table. */
export function routingFor(recId: string): RecRouting {
  return (REC_ROUTING as Record<string, RecRouting | undefined>)[recId] ?? FAIL_SAFE_ROUTING;
}
