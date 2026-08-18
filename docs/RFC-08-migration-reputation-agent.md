# RFC-08: Migrating the Reputation Agent (r2)

**Depends on:** RFC-01 (engine core, especially §8.4a's Firestore durable-step design and §9.1's tool-design rules), RFC-02 (migration recipe, §2), RFC-05 §2 (the sibling pattern of explicitly composing two agents rather than hiding a cross-agent call)
**Source material (read directly this session):** `karos-agents/products/building/reputation-agent-v2/{README.md,SKILL.md,setup/SKILL.md,manager/SKILL.md,docs/{ANALYSIS-LAYERS.md,REPUTATION-PLAYBOOK.md},references/{run-protocol.md,scoring.md},assets/engine/{ENGINE_README.md,ADAPTERS.md}}`, plus `karosCMO/scripts/register-reputation-agent-v2.ts`.
**Registration status — already further along than Instagram:** three `customAgents` docs exist (`REPUTATION_RUNNER_KEY`/`REPUTATION_SETUP_KEY`/`REPUTATION_MANAGER_KEY`, the runner un-parented as the visible card, setup/manager nested under it via `parentKey`), all `enabled: false`, `source.status: "blocked"`, created by the registration script and never enabled — same "registered but disabled, zero pilot runs" state as Carousel/Instagram (RFC-03), not the "no portal presence at all" state of Branded Shorts (RFC-06) or Landing Builder (RFC-07).

---

## 1. This product is not asking to be redesigned — it is asking to be re-hosted

Every design problem RFC-01 exists to solve — durable, resumable steps; an idempotent claim-before-write pattern; a typed distinction between a content failure and a tooling failure; a gate that runs as a separate pass from the step that produced the thing being gated — **this product already invented independently, as a convention enforced by prose rather than a platform.** `references/run-protocol.md` describes a folder-as-state-machine design (one numbered file per step, each ending in a verdict line: `NEXT`/`RETURN`/`HELD`/`HALT`/`COMPLETE`) that is, structurally, exactly RFC-01 §8.4a's `agentEngineRuns/{runId}` + `steps/{stepId}` model, just implemented as literal files in a folder instead of Firestore documents. This is the rare migration in this set where the recommendation is: **translate the existing design one-to-one onto the Firestore-backed store, rather than redesigning it.** The discipline is already correct; only the storage substrate needs to change.

Concretely, the mapping:

| This product's convention | RFC-01's equivalent |
|---|---|
| One numbered file per step, verdict line last | `steps/{stepId}` doc, `AgentStepTelemetry` outcome |
| `NEXT` / `HALT` / `HELD` / `RETURN` / `COMPLETE` | `completed` / `awaiting_gate` (a HALT needing a fix is closer to a retryable tooling state) / `awaiting_gate` (human) / a gated re-entry / `completed` |
| A step reading its own tooling failure vs. a content verdict, "never a HALT recorded as a content verdict" | RFC-01's `tooling_error` vs. `content_fail` taxonomy — the exact same distinction, independently named |
| Two claims (pulse number, `review_id`), written outside the run folder, **read back after write to confirm exactly one row** | RFC-01 §9.1's "idempotent writes on a caller-supplied key" tool-design rule — this product enforces it by a read-after-write race check; **a Firestore transaction on the claim document removes the race entirely rather than detecting it after the fact, and should replace the read-after-write pattern in the port, not just copy it** |
| A folder-writing step (drafts, flags) must write **a sibling completion file listing every item's outcome**, because "the folder existing" cannot prove the step finished | This is a genuinely sharp rule RFC-01 did not have in this specific form — worth folding into §8's orchestration-layer guidance generally: any step that fans out to N sub-artifacts needs an explicit N-row completion manifest, not an existence check |

## 2. The invariant to carry forward unchanged: the model extracts, arithmetic routes

`references/scoring.md` states the boundary this product is named for: *"The model extracts. It does not route."* A review's lane (FLAG / RESPOND / NO-ACTION) is decided by pure arithmetic over frozen weights (`triage.py`, stdlib-only, no network, fixture-locked against four golden fixtures) — the model's only job is answering five evidenced yes/no questions per review (cached once, per `(review_id, model_id)`, never re-classified) and, separately, choosing one department tag from a closed seven-value enum for flagged items. This is the cleanest real instance in the whole karos-agents catalogue of RFC-01's three-tier model policy actually mattering: the extraction pass is squarely "commodity" tier (cheap, cacheable, swappable), the routing decision is **not a model call at all** — it is a `code` step — and the drafting/doctrine-gate/voice steps are "pinned" (Opus, per this product's own model-routing table). **The one rule this migration must not relax, in either direction: a model must never be allowed to decide a lane, and arithmetic must never be asked to draft a sentence.** Any refactor that blurs this line reintroduces exactly the vibe-based routing this product was built to eliminate.

## 3. A cross-agent boundary already stated once — restate it, don't rediscover it

Same shape as RFC-05 §2's Intel-Report/SEO-GEO entanglement, but here the product already got it right: `REPUTATION-PLAYBOOK.md` §5b states plainly that Layer 4's competitor benchmark **reads** i1 Competitive Intelligence's (RFC-05, "Intel Report") `competitor-tracking.json` and run outputs, and **never re-collects competitor reputation data itself** — "one owner per data source." When this migrates, keep it as an explicit read-dependency between two `agent-engine` workflows (Reputation's analysis workflow reads Intel Report's output), not an inlined call. This is the correct version of what RFC-05 recommends fixing for Intel Report/SEO-GEO — cite it there as the working example.

## 4. Two workflows, not one — the fast pulse and the slow analysis brain

`docs/ANALYSIS-LAYERS.md` describes a **second**, slower-cadence pipeline (Layer 0 Capture → Layer 1 Response-behavior mining → Layer 2 Reputation state → Layer 3 Theme mining → Layer 4 Benchmark → Layer 5 Synthesis) that runs at client stand-up and quarterly thereafter — distinct from the pulse runner's every-3-to-7-days cadence. Layers 2 and parts of 1 are deterministic Python (`analysis.py`, fixture-locked, its own self-test); Layers 3, 4's synthesis, and 5 are model judgment (Haiku tags/extracts per item, cached; Opus synthesizes). Model this as a **second, separate `agent-engine` workflow** alongside the pulse runner — same recommendation pattern as RFC-05 §2's onboarding-vs-recurring split — rather than one workflow with two speeds folded together.

## 5. The runner's eleven steps, and where the tiers fall

| Step | What it does | Tier (per this product's own model-routing rule) |
|---|---|---|
| 01 | Open pulse, claim the number, read the client's one-off steer | code (Sonnet-mechanical) |
| 02 | Freeze frozen inputs, read live ledgers | code |
| 03 | Capture (raw before parsed, three-outcome-per-leg: ok / UNAVAILABLE / not_in_roster) | code + external API (egress-scoped, see §7) |
| 04 | Extraction (Haiku, cached, evidenced booleans) → **the deterministic engine is the routing authority** → burst computation → tag assignment | commodity (extraction) + code (routing) + pinned (tagging judgment) |
| 05 | The NO-ACTION log — silence recorded as a decision, not an absence | code |
| 06 | Draft the RESPOND lane, under four non-negotiable constraints (no fault, no blame, no financial promises, no fact not in `01-facts.md`) | pinned (Opus) |
| 07 | Client-lock gate (hard stop, not edit-and-continue) | code (deterministic string/lock matching) |
| 08 | Voice + anti-slop, read as a batch | pinned (Opus) |
| 09 | **The doctrine gate** — re-checks step 06's four constraints as a separate pass, explicitly, because "the model that wrote a sentence is the worst judge of whether it conceded fault" | pinned (Opus) — and a direct, already-articulated precedent for RFC-01 §5.6's self-correction-gate-as-a-distinct-step design |
| 10 | Apply the frozen autonomy record (today: always `approve-all`) | code |
| 11 | Payload, client folder, ledger appends, learning-log append | code |

## 6. The one real, external, non-design blocker

Live capture needs **Google-approved OAuth** for GBP and a **Yelp Fusion key**; until both land, every client is capped at the App Store's keyless feed and is force-set to `approve-all` autonomy (there is no other legal state given no reply credential exists yet). This is a credentialing and partner-approval problem, not a migration-architecture question — flag it as a precondition to any pilot, the same way RFC-04 flags Daniel/Ines's pending sign-offs as external to the migration itself. **No pilot client has also cleared the product's own "fit gate"** (`docs/reputation-client-fit.md`, referenced but not read this session) — worth reading before selecting a pilot client for the ported version.

## 7. A live, load-bearing security finding: the first agent with dynamic, shared egress

The registration script's own closing note says this outright: enabling the runner adds a **new** `review_platforms` egress group (five external review platforms) to the shared `custom` task type in `agent-service/config/egress-allowlist.json` — which means *every* custom agent, not just Reputation, gains reachability to those five platforms the moment this one is enabled. This is a real widening nobody would find by reading the reputation skill alone, and it is exactly the failure mode RFC-01's tool registry (§9, §10) needs to design against: **egress allowlists should be scoped per tool/per agent, not per shared task type**, or every future "just enable this one thing" moment repeats this silently. Fix this at the tool-registry layer before porting this agent, not as a one-off carve-out for Reputation.

## 8. The manager is a deliberate stub — respect that, do not "complete" it during migration

`manager/SKILL.md` is explicitly `mode: stub`: the folder shape and the five closing steps are fixed, but the judgment logic (learning-log entries, threshold-recalibration proposals, the monthly report) is deliberately unwritten because it can only be reviewed against real pulse data that does not exist yet. Port the shape now (so the runner and setup can be built against a stable contract); do not invent the recalibration logic speculatively. This mirrors RFC-05's own caution about not resolving gated decisions no one has made yet — here the product itself already made that call correctly.

## 9. Tools needed

- New: `reputation.capture` (wraps `capture.py`'s per-platform legs — gbp/yelp/appstore/scrape/manual_export, three-outcome contract per leg), `reputation.publish` (wraps `publish.py`; build it, but **it must be permanently gated closed at every autonomy level today** — this is a "the tool exists, the door stays locked" case, not a feature flag to leave open), `reputation.triage` — worth noting this may not need to be an agent *tool call* at all, since `triage.py` is stdlib/no-network/pure-function; it fits RFC-01's `code` step category directly, callable in-process rather than through the MCP tool layer.
- Reuse: `client.*` for the fact base and voice; `gate.numbersSourced`-style pattern for step 09's doctrine gate (four specific, quotable yes/no checks).

## 10. Portal integration

The existing three-doc `customAgents` registration (runner un-parented, setup/manager nested via `parentKey`) is the right shape and should be kept as-is when porting — same nesting convention Carousel/Instagram use (RFC-03 §6). Point `entrySkillDir`/instructions at the new `agent-engine` implementation once it exists; do not re-derive the registration shape from scratch.

## 11. Definition of done

Per RFC-02 §7, with these additions: (1) the four `triage.py` golden fixtures and the three `analysis.py` fixtures reproduce byte-identical output from the ported version before any client is scored against it; (2) the §7 egress-scoping fix lands at the tool-registry layer before this agent is enabled anywhere; (3) GBP OAuth and a Yelp Fusion key are provisioned, and a pilot client has cleared the fit gate, before a live pulse runs; (4) the manager stays a stub — ported shape only — until real pulse data exists to build its judgment steps against; (5) one full pulse runs end-to-end with every draft held for human approval, matching the product's own non-negotiable `approve-all` starting state.
