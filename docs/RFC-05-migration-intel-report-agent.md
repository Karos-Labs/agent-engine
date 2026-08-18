# RFC-05: Migrating the Intel Report to a real, Agent-Studio-managed agent

**Depends on:** RFC-01 (engine core), RFC-02 (migration recipe, §2), RFC-04 (SEO & GEO — the two are currently entangled, see §2)
**Source material (read directly this session):** `karosCMO/scripts/{regenerate-intel-report-locally.ts,persist-intel-report-locally.ts}`, `karos-agents/catalog/products-catalog.json` (products `o1` and `i1`)
**Not yet read directly this session (confirm before implementing):** `karosCMO/src/lib/intel/report.ts` (`runIntelReportPipeline`), `karosCMO/src/lib/intel/brain.ts` (`DEFAULT_INTEL_PROMPT`), `karosCMO/src/lib/intel/pipeline.ts` (`runOnboardPipeline`), `karosCMO/src/lib/report-parser.ts` (`parseMarkdownReport`/`buildClientReport`), and the "weekly radar" mechanism referenced by the catalog (likely `karos-agents/docs/COMPETITIVE-RADAR.md` / `docs/competitive-radar/`, and `karosCMO/src/lib/intel-schedule.ts`, seen in a directory listing but not opened). **This document is a migration plan built from the calling scripts and the product catalog, not from the pipeline's own source — verify §3's assumptions against `brain.ts`/`report-parser.ts` before writing code.**

---

## 1. This is the one place your instruction ("make it sit like all the others") is the entire scope

Unlike SEO & GEO (RFC-04), which is architecturally sophisticated and mostly needs careful *extraction* without breaking its determinism, the Intel Report's core problem is structural and organizational, not algorithmic: **it is a hardcoded Next.js library call triggered by an admin button, with no job record, no portal-visible run history, no per-step cost/telemetry, and no Agent Studio configurability** — while every other agent in this document set (X, Instagram, and now SEO & GEO once RFC-04 lands) has at least a `customAgents`/dynamic-agent document giving it a place in the portal's normal machinery. Your instruction is precise: **give it that place.** This RFC is about the wrapping, not primarily about rewriting the report-generation logic itself (though §4 identifies one real improvement worth making while it's being touched anyway).

## 2. The entanglement with SEO & GEO — make it explicit, don't carry it forward silently

`regenerate-intel-report-locally.ts`'s own header states this plainly: *"SEO/GEO is already included, not a separate step: `runIntelReportPipeline` calls `runOnboardPipeline`, which runs `runSeoGeoResearch`... alongside the report and context docs."* Concretely: today, pressing "Regenerate" on the Intel Report **also silently regenerates the client's SEO/GEO snapshot** as an internal side effect nobody configuring the Intel Report would necessarily expect.

**This is exactly the kind of hidden coupling `agent-engine`'s explicit workflow model (RFC-01 §4, §8) is designed to make visible instead of implicit.** Recommendation: do not port this as one opaque call. Model it as what it actually is — **two agents, composed explicitly**:

- The Intel Report workflow (this document) is one `agent-engine` workflow.
- The SEO & GEO workflow (RFC-04) is a separate workflow.
- At **onboarding time only**, the platform's onboarding orchestration (whatever calls `runOnboardPipeline` today) invokes both explicitly — Intel Report and SEO & GEO baseline — as two visible steps, not as one function silently doing both. At **recurring-refresh time**, they run on their own independent cadences (Intel Report on "the weekly radar" cadence per the catalog; SEO & GEO monthly as the `a3` SKU per RFC-04 §3) and should **not** re-trigger each other.

This is a real design decision with a real cost (two workflow definitions and an explicit composition step at onboarding, instead of one function call) — flag it to Shlomi/whoever owns onboarding before implementing, but it directly fixes a real, currently-invisible behavior (an admin pressing "regenerate the Intel Report" not realizing they just re-spent the SEO/GEO research budget too).

## 3. What the current pipeline actually produces — inferred from the parser's expectations, verify against the real prompt

`persist-intel-report-locally.ts` reveals the shape of a `ClientReport` precisely, because it exists specifically to parse a hand-authored report into that exact shape: an overall score + grade, competitor rows, seven distinct analysis sections (**content, conversion, seo, geo, positioning, brand, growth**), a SWOT (strengths/weaknesses/opportunities/threats), a recommendations list, and brand-voice rows + archetypes. This is a genuinely rich, structured deliverable — the markdown format is just its current transport, not its real shape.

**Recommended workflow shape** (verify phase boundaries against `brain.ts`'s actual prompt before finalizing — this is a reasonable decomposition, not a confirmed one):

| # | Step | Tier | Tools | Notes |
|---|---|---|---|---|
| 1 | Load client context | code | `client.getProfile`, `client.getBrand`, `client.listCompetitors` | Same profile-reading pattern every other agent uses. |
| 2 | Competitive research pull | agent, bounded | `research.pull` | The evidence base for the competitor rows and the "leader statements" the catalog describes ("evidence-backed leader statements, no scoring" per product `i1`'s step description). |
| 3 | Generate the report sections | agent, bounded — **recommend splitting the current one-shot `DEFAULT_INTEL_PROMPT` into per-section generation steps** (content, conversion, seo/geo, positioning, brand, growth, SWOT, recommendations) rather than one giant prompt producing one giant markdown blob | craft skill (the migrated `DEFAULT_INTEL_PROMPT`, decomposed) | See §4 for why this split is worth doing now rather than porting the monolith as-is. |
| 4 | Score + grade | code, if the scoring is in fact deterministic (verify against `brain.ts`); otherwise a tightly-schema-constrained bounded agent step | `gate.numbersSourced`-style check | "No grade" is explicitly the policy for the *onboarding* Intelligence PDF per the catalog (`o1`'s "Intelligence PDF" step: "Dated Market & Competitive Intelligence Report. **No grade.**"), but the parser clearly expects `overallScore`/`overallGrade` fields — **reconcile this discrepancy before implementing**: either the recurring `i1` version does carry a score while the onboarding one-time PDF doesn't, or the "no grade" language is stale relative to the parser. Don't guess; check `brain.ts` and the two calling contexts. |
| 5 | Assemble + persist | code | new `intel.writeReport` tool wrapping `upsertClientReport`/`replaceReportCompetitors` | Structured output in, typed Firestore write out — no markdown round-trip needed if step 3 emits structured JSON directly (see §4). |

## 4. The one real architectural improvement worth making here: drop the markdown-parsing round-trip

Today: the model writes markdown → `parseMarkdownReport` regex/heading-matches it back into structured fields → `buildClientReport` assembles the Firestore document. This is exactly the kind of fragile, heading-literal parsing layer that a **typed output schema** (RFC-01 §5.1's `outputSchema: ZodSchema<TOutput>`, enforced via Claude's native structured-output support) eliminates outright: have each generation step return the structured section content directly, validated against a Zod schema, with no intermediate markdown-heading contract to keep in sync between the prompt and the parser. `persist-intel-report-locally.ts` exists *specifically* as a workaround for exactly this fragility (it lets someone hand-author a report as long as they match the parser's exact heading structure) — a typed-output migration removes the reason that workaround was needed, though keep an equivalent "manually supply a report" escape hatch (useful for the "authored outside the app's own Claude integration" case the script's own comments describe) — just have it accept structured JSON instead of heading-matched markdown.

**Do not attempt this simplification blind** — read `brain.ts` and `report-parser.ts` first (they were not read this session; see the header of this document) to confirm the exact section boundaries and any formatting nuance (e.g. specific bullet conventions the client-facing PDF renderer expects) before collapsing the markdown layer.

## 5. Tools needed

- Reuse: `client.*`, `research.pull` (RFC-01 §9.2), `gate.numbersSourced` (directly relevant — a competitive intelligence report making unsourced claims is exactly the failure mode this gate exists to catch, and it's a natural fit given the catalog's own "evidence-backed... no scoring" language for the competitor step).
- New: `intel.writeReport` (wraps the existing `upsertClientReport`/`replaceReportCompetitors` Firestore calls — keep these calls themselves unchanged, just move them behind a typed tool instead of a direct library import from a workflow step, per RFC-01 §4's layer invariant).

## 6. Portal integration — the actual point of this migration

Register a new `customAgents` or (preferred, per RFC-04 §6's reasoning) Dynamic Agent Studio spec for "Intel Report" / "Competitive Intelligence," following the Instagram Agent's registration pattern (RFC-03 §6 — instructions sourced from a git-tracked doc, not inlined in a script). This gives it, for the first time:

- A real job/run record visible in the portal, instead of a "Regenerate" button that either silently succeeds or throws in a server console nobody but an admin with terminal access sees (`regenerate-intel-report-locally.ts` exists specifically because there was no other way to re-run it without a browser and a session cookie — that workaround becomes unnecessary once it's a real, portal-triggerable agent run).
- Per-step cost/telemetry (RFC-01 §11) — today there is no visibility into what a regeneration actually costs.
- A recurring schedule slot for "the weekly radar" cadence, instead of whatever ad hoc mechanism currently triggers it (confirm what that is — `intel-schedule.ts` was seen in the codebase listing but not read this session).
- Compatibility with the explicit composition with SEO & GEO described in §2, instead of the current hidden coupling.

## 7. Definition of done

Per RFC-02 §7, with these additions: (1) §3's phase decomposition is verified against the real `brain.ts` prompt and `report-parser.ts` before implementation, not built from this document's inference alone; (2) the score/grade discrepancy noted in §3 step 4 is resolved with whoever owns the product decision, not silently picked; (3) the onboarding-time SEO/GEO coupling from §2 is either kept as an explicit two-step composition or deliberately decoupled — either is acceptable, but it must be a decision someone made, not a side effect nobody noticed carried over from the old code; (4) the agent is visible, configurable, and has real run history in Agent Studio for at least one real client before this is called complete.
