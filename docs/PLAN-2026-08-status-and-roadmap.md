# Status & Roadmap — August 2026

**What this document is:** a plan, not a spec. RFC-01 through RFC-10 describe architecture and migration designs; several were written before the repo reached its current state and are now stale in places (noted inline below). This document replaces the stale parts and gives a single, priority-ordered answer to "what do we actually do next," grounded in a direct read of the real repo on 2026-08-20 (commit `f17e640`, the same commit the self-audit at `audit-scorecard.html` scored) — not in the scaffold-stage assumptions this project started from.

**Standing priority, unchanged:** SEO & GEO is the workstream that matters most right now, because it is the one area where real, paying clients are waiting on improvement today, while the rest of the agent migration serves zero pilot clients yet. Everything below is ordered against that, per the earlier decision recorded in RFC-02's rollout-table preamble.

---

## 1. The repo is much further along than the RFCs assume

The RFCs (especially RFC-02 through RFC-10) were written when `agent-engine` was closer to scaffold. It is not, anymore:

- All 12 agents the migration ever targeted exist as real packages — the original six channel agents *and* `reputation-agent`, `landing-builder-agent`, `branded-shorts-agent`, `seo-geo-agent`, `instagram-agent`, `intel-report-agent`, plus `campaign-orchestrator`.
- 31 workspaces, 161 test files, **1,294 tests passing, 0 skipped-that-matter, 0 TypeScript errors** at HEAD.
- A real, already-run 360° self-audit exists (`audit-scorecard.html`): overall health 75/100, with one P0 and roughly 20 P1 findings, each with an exact file:line and a prescribed fix. Section 4 below is the priority-ordered subset of that audit that actually gates the SEO&GEO work; the rest of the audit stands as-is and doesn't need restating here.
- Only six products are dispatchable through the server today (`KNOWN_PRODUCT_IDS` in `apps/agent-server/src/wiring/workflows.ts`): `x-agent`, `linkedin-agent`, `reddit-agent`, `blog-agent`, `newsletter-agent`, `campaign-orchestrator`. `instagram-agent`, `seo-geo-agent`, and `intel-report-agent` are built and tested but not wired to dispatch. `reputation-agent`, `landing-builder-agent`, and `branded-shorts-agent` are *also* built and tested (confirmed directly: their tool packages — triage, gates, video tools — are all present and match RFC-06/07/08's designs closely) but aren't in `KNOWN_PRODUCT_IDS` *or* the root `build` script — this second gap is already flagged in the audit as a P1 ("Build script omits the three newest tool packages and their agents").

None of this changes the priority call. It changes what "improve SEO/GEO" concretely means, because far more of it is already built than assumed when RFC-09/RFC-10 were written.

## 2. The central new finding: two SEO/GEO systems now exist, and they don't agree

This is the most important thing this plan needed to surface, and it wasn't visible until reading the actual `packages/tools/karos-seo-geo` and `agents/seo-geo-agent` source.

**System 1 — `karosCMO/src/lib/seo-geo.ts` (live, production, real clients today).** Simple model: `VisibilityGap` → `FixAction` (9 fixed actions) → `ActionKind` (`one_click`/`review_approve`/`connect`/`guided_manual`) → `Recommendation`. `approveSeoGeoRecommendation` records an approval and nothing consumes it yet. This is what RFC-09 and RFC-10 were designed against.

**System 2 — `packages/tools/karos-seo-geo` + `agents/seo-geo-agent` (built since, not yet connected to anything).** This is a full, independent, much richer re-implementation:

- A 75-`rec_id` catalog (`config/rec-catalog.data.ts`, 51KB) with a priority-scoring formula (`100·impact·effort + 20·(1−worst_norm) + 10·(fail) + 5·deliverability − 3·evidence_penalty`, plus a hard-override jump for 5 critical-eligibility recs) ported, per its own comments, "verbatim" from a `seo-geo-routing-config.json` design — this is the same shape as the `karos-agents` reference doc (`SEO-GEO-RECOMMENDATION-AUTOMATION.md`) that RFC-09 flagged as "documented but doesn't exist in this stack." It now does exist — just not in karosCMO, and not connected to the live system.
- A real, tested `seoGeo.score` / `seoGeo.recommend` tool pair (deterministic, fixture-locked, "model extracts, arithmetic routes" held exactly).
- A full 19-step `BaseAgent` workflow (`create-seo-geo-agent-workflow.ts`) with human gates on the prompt set and on fix generation, a fanout capture phase, a `BaseAgent` step that **drafts fix copy** (`13-draft-fixes`), a narrative-writing step with a numbers-verification step immediately after it (guards against the narrative hallucinating a number the scorer didn't produce), and a persisted report deliverable. This is a real, working advisory pipeline — closer to "done" than RFC-09 assumed when it designed the actuator from scratch.
- A fully designed (not yet applied) Google-connector overlay for GSC/GA/CrUX/GBP — read-only measurement connectors, with a careful connected/unconnected fallback ladder, reproducibility-hash handling, and privacy rules (a zero-anon token table, no wire-readable connection-status column). The design doc for this (`config/seo-geo-connectors-config-edits.txt`) is explicit that it's **gated on a named sign-off ("Daniel's sign-off") and not yet applied** to the scoring config.
- Confirmed dead ends, honestly reported by the code itself, not by me: technical SEO measurements are hardcoded to `coverage: "unavailable"` for every input (step 06's own comment explains why); the connector-overlay step reports every connector as `connected: false` with `pendingConfigEdit.status: "GATED_NOT_APPLIED"`; `.env.example` has zero variables for any of GSC/GA/CrUX/GBP or any CMS. **This agent has never run against one real client's real data.** It is a fully-built, fully-tested pipeline with the fuel line disconnected.
- It is not in `KNOWN_PRODUCT_IDS`. It has no path into the portal. Its `FiredRecommendation` type has no relationship to karosCMO's `Recommendation`/`ActionKind` type — a client viewing their portal today sees System 1's simpler recommendations; System 2's richer, prioritized, fix-drafted, narrated report exists only as a deliverable this system could produce, for nobody, in a pipeline nothing calls.

This supersedes RFC-09 §2 and RFC-10's implicit assumption that the actuator would be layered on top of karosCMO's existing types. It doesn't invalidate RFC-09/RFC-10's actuator *design* (the three-path apply model, the "always preview before applying" rule, the job-visibility requirement) — it means the actuator has to be designed against **whichever of these two recommendation systems the portal ends up serving from**, and that has to be a real decision, not a default.

**My recommendation, since you've asked for the opinion and not just execution:** don't retire either system yet, and don't silently pick one. Ship a thin compatibility mapping — project System 2's `FiredRecommendation[]` into System 1's `Recommendation` shape (a `recId → actionKind/title/description` adapter, the same kind of mapping `actionKindFor`/`ownerFor` already do inside `seo-geo.ts`) so the portal can start surfacing the richer, prioritized catalog to real clients within days, without a portal data-model rewrite. Treat "fully migrate the portal onto System 2's native types and retire System 1" as a separate, later decision once System 2 has run against real client data at least once. Building the actuator against System 1's simpler shape first, then widening it, is lower-risk than building it against System 2's richer shape before System 2 has ever seen a real client.

## 3. Priority-ordered plan for SEO & GEO

This is the concrete "how do we raise the tools" answer for the workstream you named as most important. Ordered — each phase should be substantially done before the next starts real work, though design can overlap.

**Phase A — Reconcile the two systems (days, not weeks).** Write the compatibility mapping from §2 above. Get the actual decision-maker (Daniel, per the code's own comment) to sign off on it explicitly — this is a real product decision, the same category of decision RFC-07 and RFC-09 both flagged and declined to make silently. Do not build anything past this phase until it's made, or the actuator in Phase E gets built against the wrong shape.

**Phase B — Connect real data (this is the actual "nothing is improving SEO/GEO yet" gap).** The engine is real; it has never touched real data. Concretely: (1) get sign-off on and apply the gated Google-connector config edit; (2) wire real OAuth for GSC/GA/CrUX/GBP through the existing `ClientIntegration` + `token-cipher.ts` pattern — this is infrastructure that already exists for Instagram/LinkedIn/Google, being extended, not invented; (3) wire a real technical-SEO crawler so step 06 stops hardcoding `unavailable`; (4) confirm whether the AI-visibility capture fanout (step 07) is real or also stubbed — this wasn't verified this session and is the single most important open question before claiming any of this "improves SEO/GEO" for a client. Nothing downstream of this phase (recommendations, fix drafts, narrative, actuator) means anything until this lands.

**Phase C — Dispatch it.** Add `seo-geo-agent` to `KNOWN_PRODUCT_IDS` and to the root `build` script (the latter is already an audit P1; fold it in here rather than as a separate cleanup task, since it blocks this phase literally). Do the same for `reputation-agent`, `landing-builder-agent`, and `branded-shorts-agent` at the same time — they're equally built, equally tested, and equally stuck behind this one gap; there's no reason to leave three finished agents undispatchable while fixing this for a fourth.

**Phase D — Portal wiring.** RFC-10 as written, adjusted for the Phase A compatibility layer: the recommendation card renders from the mapped `Recommendation` shape; approving a recommendation creates a real Dynamic Agent Studio job; the CMS connect flow and the guided-kit/scoped-chat delivery reuse existing portal infrastructure exactly as RFC-10 §4–§5 describe. RFC-10's own header note — that no one has yet confirmed a `Recommendation[]`-rendering component exists in the portal at all — still needs to be resolved before this phase starts, not during it.

**Phase E — The actuator.** RFC-09 as written (the three-path apply model: direct write, dispatch to another Karos agent, guided kit), built against whatever Phase A produced. Do not start `cms.applyFix` — RFC-09's own flagged highest-risk tool, since it writes to a client's live production site — until the Phase 4 P0 below ships. Ship the lowest-risk one_click action first (`search.requestIndexing`, per RFC-09 §9), end-to-end, on one real client, before touching CMS writes on anyone's site.

## 4. What has to be true before *any* of Phase B–E ships a credentialed write

Pulled from the existing audit, filtered to only what actually gates this workstream — the rest of the audit's ~20 P1s and ~30 P2s are real but not blocking and shouldn't be allowed to compete with this list for attention right now:

- **P0 — `allowedTools` is advisory, not enforced**, in `packages/core/src/agent/base-agent.ts`. This is the single finding that has to close before `cms.applyFix` (or any other write-capable tool) is trusted anywhere near a `BaseAgent` loop — an allowlist a compromised/confused model can ignore isn't a sandbox. This blocks Phase E outright, not just "should fix eventually."
- **P1 — Landing gate runs `npm run build` on model-authored code with `shell:true`.** The audit's own words: "becomes P0 the moment landing-builder deploys alongside credentialed workloads" — which is exactly what dispatching it in Phase C does. Fix before Phase C, not after.
- **P1 — write-fence gaps**: unsanitized `clientSlug`, unfenced `video.*` tools, absolute-path bypass (RFC-07 already specified the realpath-containment fix; it hasn't shipped).
- **P1 — no app-layer authz on the runs API** (any Cloud Run invoker can act on any tenant). Fine while exactly one trusted caller holds invoker rights — worth confirming that's still true before Phase C adds four more dispatchable, credentialed agents to that same unauthenticated surface.
- **P1 — `resolveGate` silently overwrites an already-resolved gate.** Directly relevant here: Phase A/D both depend on human-gate approvals being a trustworthy audit trail (fix-generation-review, prompt-set-review, and eventually the actuator's own approval gate). This bug means a second resolve can flip that record after the fact.
- **P1 — blended mention rate ignores `N_e`** (`karos-seo-geo/src/visibility-metrics.ts`). This is inside the exact scoring path Phase B is about to connect to real data — worth fixing alongside Phase B rather than after, since it directly affects what score a real client sees.
- The **N/N_e denominator decision** is already an explicit, named blocker inside the code itself (`SeoGeoReport.visibility.denominatorDecision.status: "pending"`, `blockingOn` field) — not something this plan is inventing. Someone needs to actually decide it; the code has been carrying both computations and defaulting silently to N pending that decision.

Everything else in the audit (retry/backoff on LLM calls, the GCS/file store listing divergence, LLM adapter test gaps, the ~30 P2s) is real and worth doing, but none of it gates SEO&GEO specifically — don't let it compete with the list above for the next few weeks.

## 5. What not to do right now

- Don't build further channel-agent migrations or polish — the six already-dispatchable agents plus the four now-ready-to-dispatch ones (Phase C) cover everything RFC-02 originally scoped. There is no more migration backlog worth prioritizing over this.
- Don't start on `cms.applyFix` before the `allowedTools` P0 ships — this is the one item on this whole plan with a real, direct security consequence if sequenced wrong.
- Don't let Phase A get skipped or defaulted silently. Building the actuator (or the portal card) against whichever system happened to get touched first is exactly the kind of unreconciled-duplication problem this project has hit twice already (Landing Builder's catalog conflict, the earlier karos-agents-vs-karosCMO SEO/GEO doc conflict) — both times the right call was surfacing it for a decision, not resolving it silently, and that's the call here too.
- Also fix the already-known broken `npm run demo:agents` script while touching the build script for Phase C — it's a small, low-risk fix (update the hardcoded step list/count and either pass `autoApprove: true` or resolve the `15-batch-review` gate) that's currently actively misleading about repo health if anyone runs it without reading the README's caveat first.

## 6. Near-term punch list

1. Confirm whether the AI-visibility capture fanout (workflow step 07) is real or stubbed — blocks knowing what Phase B actually requires.
2. Get the Phase A compatibility-mapping decision made and documented.
3. Get sign-off on and apply the gated Google-connector config edit; wire GSC/GA/CrUX/GBP OAuth through `ClientIntegration`.
4. Ship the `allowedTools` enforcement fix (P0) — do this in parallel with 1–3, it's on the critical path for Phase E regardless of how long Phase A/B take.
5. Fix the Landing gate `shell:true` build risk and the write-fence gaps before Phase C dispatches `landing-builder-agent`.
6. Add all four ready agents to `KNOWN_PRODUCT_IDS` and the build script together; fix `demo:agents` in the same change.
7. Resolve the N/N_e denominator decision.
8. Ship RFC-10's portal wiring against the Phase A mapping; confirm/build the `Recommendation[]`-rendering component first if it doesn't exist.
9. Build RFC-09's actuator, lowest-risk action first, one real client, before `cms.applyFix` touches anyone's live site.
