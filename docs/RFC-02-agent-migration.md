# RFC-02: Agent Migration Playbook — From Skill to `BaseAgent`

**Project:** `agent-engine` (same repository as RFC-01)
**Status:** Draft for implementation — hand this to Claude Code *after* RFC-01's tool layer (§9) and `BaseAgent` (§5) exist, or in parallel once the first pilot agent's tool needs are scoped
**Depends on:** RFC-01 (Agent Engine Core)

---

## 0. Purpose

RFC-01 defines the engine: `BaseAgent`, the workflow primitives, the tool registry. This document is the **repeatable recipe** for turning one existing skill (today: a `SKILL.md` plus its `references/` and any executable engine under `assets/engine/`) into a concrete, working agent on that engine — plus the worked reference example (X / e13) and the rollout order for the rest.

Feed this document to Claude Code one agent at a time: "Migrate the X agent per RFC-02 §3," then later "Migrate LinkedIn per RFC-02 §5 using the same recipe." Each migration is independent and non-destructive — the legacy `agent-service` implementation keeps serving that agent's traffic until the new one passes its evals and a shadow-run comparison.

---

## 1. Preconditions

Before migrating any single agent:

- RFC-01 Phase 1 is far enough along that at least the tool servers this agent actually needs exist (you do **not** need every server in RFC-01 §9.2 built before starting the pilot — build the pilot's tools first if that's faster, and treat it as the forcing function for the shared registry).
- You've picked which agent goes first. **Recommendation: X (e13)** — see §3 for why.

**A complementary, lower-friction option worth running alongside the X pilot (confirmed against the real `karosCMO` codebase, not assumed):** Dynamic Agent Studio specs (`DynamicAgentSpec`/`DynamicAgentStepDef`/`DynamicAgentRunStep`, see RFC-01 §7) already have a typed, sequential step contract in production today, executed by `agent-service/runner/src/dynamic/step-runner.ts`. Because that contract maps almost one-to-one onto RFC-01's step model (an `"ai"` step → one `BaseAgent`, a `"code"` step → one Layer 1 step), standing up `agent-engine` as the execution engine behind **one existing Dynamic Agent spec** is likely the single fastest way to get a real, portal-integrated, end-to-end proof of the new engine running in production — with effectively zero portal-side changes, since the output contract (`DynamicAgentRunReport`) doesn't change shape. This doesn't replace the X pilot (X proves the harder case: a hardcoded legacy skill with real fan-out, gates, and a research connector) — it's a good "prove the wiring works" first step that can run in parallel, since it's a much smaller slice of RFC-01 to stand up. Confirm with Shlomi which existing dynamic-agent spec is the simplest candidate before starting this track.

---

## 2. The conversion recipe (apply per agent)

### Step 1 — Inventory the skill

Read the existing `SKILL.md`, its `references/`, and any executable code under `assets/engine/`. Note:

- The step sequence and handoff points (what today's numbered artifacts in `internal/` represent).
- Every external call the skill's prose instructs the model to make (an API, a scrape, a specific fallback chain).
- Every write the skill instructs (a ledger row, a memory update, a topic reservation).
- The craft content — voice guidance, format rules, hook shapes, worked examples, anything that's genuinely "how to write well for this platform," not "what to call in what order."
- Any client-specific learned rules layered on top of the base skill.

### Step 2 — Sort the content into four buckets

| Content in the skill today | Where it goes |
|---|---|
| Step sequence, handoff points, resume protocol | **Workflow definition** (RFC-01 Layer 1) |
| "Call this API, fall back to that one" | **Tool implementation** (RFC-01 Layer 3, likely already exists as `karos-research`) |
| "Write this ledger row" | **Tool call** (Layer 3, `karos-ledger`) |
| Voice, format rules, hook shapes, worked examples | **Stays a skill** — loaded by whichever `BaseAgent` step needs it, unchanged in spirit |
| Client-specific learned rules | **Client policy record**, rendered into the relevant step's prompt |

This mapping is the whole exercise. If you find yourself unsure whether something is a workflow step or a craft rule, ask: *does getting this wrong produce a bug, or produce bad writing?* Bugs go to code; bad writing stays a skill.

### Step 3 — Define the workflow (Layer 1)

Most agents need **two workflows**: a **setup workflow** (runs once per client, a pure data producer) and a **recurring producer workflow** (runs per cadence). Write each as a step table:

| # | Step | Tier | Tools | Output | Resume semantics |
|---|---|---|---|---|---|
| 1 | … | code / agent-bounded / agent-open | … | … | … |

Use RFC-01 §8.2's illustrative shape as the template. Pay specific attention to:

- **Where the human gate sits**, and confirm anything that should run *after* resume (like updating memory/topics) is placed after the gate in the workflow graph — not dependent on someone remembering to run it.
- **Fan-out points** — anywhere the agent produces N items (N platform drafts, N competitor summaries), make that a `fanout(slots, ...)` over per-slot subagents, not a single long-running loop.

### Step 4 — Define the `BaseAgent` subclass(es)

One subclass per bounded-judgment unit of work — typically one per "draft this," one per "derive this," rarely more than 2–3 per agent. Each subclass supplies:

- `allowedTools` — the narrow, explicit tool list this step actually needs (usually a subset of the shared registry from RFC-01 §9.2).
- `outputSchema` — a Zod schema for the terminal output.
- `modelPolicy` — pick the tier (§RFC-01 §5.4): drafting/voice work is almost always `pinned`; extraction/ranking/summarization is usually `portable`; classification/dedupe is `commodity`.
- `skillRef` — which skill (and which slice of it) this step loads as craft-policy content.
- `selfCritique` — which gate tool validates this step's output, if any.

### Step 5 — Extend the tool registry, only if genuinely new

Most agents should reuse the shared servers from RFC-01 §9.2 without modification. Add a new tool only for something genuinely agent-specific (e.g. a platform-specific publish constraint, or a connector this agent alone uses). Resist the urge to fork a tool per agent — that's how the current system's documentation drift (RFC-01 §9.1 rule 6) happened in the first place.

### Step 6 — Define gates specific to this agent

Character limits, forbidden words, platform format rules, "no fabricated numbers" — express each as a typed `karos-gates` tool per RFC-01 §5.6/§8.3, not as a prose instruction to "please check before returning."

### Step 7 — Build the eval dataset

Per RFC-01 §12:

- 20+ realistic edge-case scenarios (complex brand rules, multi-seat setups, conflicting client instructions).
- Deterministic assertions from the gate tools (free, run on every commit).
- A rubric-judged sample (voice fidelity, hook strength, platform-convention adherence) scored 1–5 by a strong judge model.
- A frozen golden run with a human-endorsed output, signed off *before* the pilot's first real run.

---

## 3. Reference worked example: X Agent, end to end (corrected against the real repo)

X is the recommended pilot: it already has the most detailed documented run-protocol of any agent to translate from, and its research leg is comparatively narrow (xAI search + a news pull). **This section was rewritten after a direct read of `products/building/x-agent-v2/` and the karosCMO scripts that register it — the version below reflects the real, currently-deployed behavior, which differs from what the committed `SKILL.md` describes. See RFC-01 §16.2 for how that drift happened and why it matters beyond just this agent.**

### The correction that matters before anything else

`products/building/x-agent-v2/SKILL.md` and its `references/` (`run-protocol.md`, `lanes.md`) describe a **batched run**: one run drafts N posts (5, 10, or 21) across six lanes, with slot ids `p01`–`p10`. That is the committed, in-repo design. **It is not what currently runs.** The system prompt actually deployed to production (embedded in `karosCMO/scripts/register-x-agent-v2.ts`) carries an explicit, dated override: *"One run produces exactly one post. This is the product ruling of 2026-08-11 and it supersedes the skill's own batch framing wherever the two disagree."* One run belongs to one identity (the company page, or a single seat); it drafts a single post, choosing one avenue by a fixed precedence (client's request → identity's stated lane preference → identity's top-weighted lane), and delivers exactly one post even if the request asks for "a batch."

**Build the migrated agent against the one-post-per-run behavior.** The batch framing below (slot fan-out, six lanes competing in one run) is preserved in this document only because the underlying step *mechanics* (research-once, gate-per-draft, resumable numbered steps) are still exactly right and still worth reusing — just with slot count effectively fixed at 1 for now. If the product later reverts to real batching, the fan-out primitive (RFC-01 §5.5, §8.2) is what you'd re-enable; don't build a special one-post-only code path that would need to be undone.

### The real run protocol (from `references/run-protocol.md`, read in full)

The existing v2 skill already thinks in almost exactly RFC-01's terms, which is precisely why it's the best pilot:

- **Run identity**: `clients/<slug>/outputs/x-agent/<YYYY-MM-DD>-<account>-<nn>/attempt-<k>/`, where `<account>` is the triggering identity, `<nn>` is that identity's same-day sequence (assigned once, at open, recorded rather than recomputed), and `<k>` is the attempt number (resume continues the same attempt; a deliberate re-run opens the next one). This maps directly onto RFC-01 §8.1's run identity + slot identity, with the useful correction that "assigned once, recorded, never recounted" is exactly the discipline a Firestore-doc-per-run gives you for free (RFC-01 §8.4a).
- **Slot ids from position, never content** (`pXX`, assigned at the subject-selection step) — this is the *exact* rule RFC-01 §8.1 independently specifies, already present and already correctly reasoned about in the real skill ("a model asked to name the same subject twice produces two different names, so a content-derived id... cannot dedupe, resume, or address anything reliably").
- **Pin inputs before reading them** (step 01 copies every file the run will read) — maps onto RFC-01's checkpoint/idempotency discipline; the tool-registry equivalent is a `client.*`/`research.*` read that gets snapshotted into the run's own Firestore step record rather than re-read live on resume.
- **Save paid payloads before parsing** (steps 04/05 write the full verbatim research response before anything filters it) — exactly RFC-01 §9.1's tool design rules in practice; `research.pull` (RFC-01 §9.2) should persist the raw payload as part of its own write, not leave that to the calling step.
- **Three real outcomes, not the generic two**: `delivered` (posts passed every gate), `held` (nothing cleared the gates honestly — a legitimate, non-failure outcome), `blocked_intake` (the client hasn't supplied required inputs yet — a client-side gap, not an agent fault). **Reconcile this with RFC-01 §6's outcome taxonomy explicitly**: `held` is this agent's name for a clean `content_fail`-driven empty result (not `failed`), and `blocked_intake` deserves its own recognizable status rather than being folded into a generic failure — the skill's authors independently arrived at the same principle RFC-01 argues for (don't collapse distinct outcomes into "failed") and it's worth preserving their exact vocabulary in the migrated agent's status reporting where it doesn't conflict with the portal's `JobStatus` enum (RFC-01 §7.1).

### Setup workflow (runs once per client — out of scope for the v2 skill itself, confirm current state before rebuilding)

The v2 skill explicitly assumes a client that's already been built (foundation, voice profile, seeded topic catalog) — building that is a separate, earlier skill this document doesn't re-derive. Confirm with Shlomi whether that setup path also needs a workflow rewrite in this pass, or whether it's out of scope for the pilot (recommendation: out of scope — migrate the recurring, on-demand run first, since that's what's live and what §16.5's open question is actually about).

### Recurring, on-demand run (per click — corrected to one-post-per-run)

| # | Step (real, from `run-protocol.md`) | Tier | Tools | Resume semantics |
|---|---|---|---|---|
| 00 | Intake check | code | `client.getProfile` | Hard gate: no foundation file yet → outcome `blocked_intake`, stop |
| 01 | Pin inputs + assemble context | code | `client.*`, `memory.read` | Inputs copied/snapshotted once; read-only after this step |
| 02 | Assemble "shelf" (recent posts, feedback, radar) | code | `client.*` | Cached per run |
| 03 | Feeds + feedback pull | code | `research.pull` (shelf-scoped) | — |
| 04 | xSearch research pull | agent, bounded | `research.pull`, `research.checkFreshness` | Verbatim payload persisted before parsing (rule above) |
| 05 | News research pull | agent, bounded | `research.pull` | Same rule |
| 06 | Candidate subjects + drops | agent, bounded | craft skill (subject selection) | — |
| 07 | Choose the one subject (precedence rule above) | code | — | Slot id `p01` assigned here, from position |
| 08 | Angle it | agent, bounded | craft skill: `x-craft.md` §4 (load-bearing — see note below) | — |
| 09 | Draft | agent, bounded | craft skill, `render.preview` | Per-attempt checkpoint |
| 10 | Machine gate (`lint.mjs`, ported to a typed tool) | gate | `gate.lintPost` | Typed verdict; a tooling failure in the linter itself is never recorded as a content rejection (this was a real, named bug in v1 — see the SKILL.md's own "four changes that matter") |
| 11 | Claim gate | gate | `gate.numbersSourced`-style tool, given the source text directly (not just the claim) | Content-level failure returns to step 09 with the reason |
| 12 | Compliance gate | gate | `gate.brandCompliance` | Same |
| 13 | Write client deliverable + manifest | code | `ledger.writeDeliverable` | Idempotent on `(run_id, slot_id)`; manifest makes step 13 itself resumable (the one step whose product lives outside `internal/`) |
| 14 | Delivery check | code | verifies `client/` against the manifest | Catches a half-written client folder |
| 15 | Commit (ledger, topic catalog, learning log) | code | `topics.commit`, `memory.appendDecision`, `ledger.feedbackAppend` | Runs only after the deliverable exists on disk/in Firestore; each sub-write recorded as it completes, checked for "already written" before appending (prevents double-counting on a resumed commit) |

**Two craft-policy notes to carry forward, not lose in the rewrite:**

- `x-craft.md` section 4 is explicitly called out in the skill's own docs as load-bearing: it's specifically what closes the quality gap between model tiers on the highest-volume lane, and the measured model-tier parity that justifies running this on `claude-sonnet-5` instead of a more expensive tier holds *only* with those rules in place. When this becomes a `skillRef` in the new prompt store (RFC-01 §16.1), migrate this section with the same care as code — don't summarize it away.
- The real `customAgents` Firestore document for X v2 already declares its resolved model explicitly (`model: "claude-sonnet-5"`, overriding a platform default of a heavier tier) with a comment citing a "cost-parity-tested choice" — this is a real, already-validated instance of RFC-01 §5.4/§7.3's tiering policy in action, not a hypothetical. Carry the same model choice forward rather than re-deciding it from scratch.

**What doesn't change for the person configuring this in the Studio:** the five questions they've always asked about an agent — what does it read, what can it publish, what needs my approval, can I still change its voice by talking to Claude, what did it decide and why — all still have answers, and question four gets a *better* answer than today: craft rules, voice, formats and judgment stay editable by talking to Claude (now via the prompt store in RFC-01 §16.1, not a raw file); what moves to code is the plumbing nobody was hand-editing anyway. State this explicitly when you present the migrated agent — it's the objection that stalls agent rebuilds when it isn't addressed up front.

---

## 4. Per-agent spec template

Copy this table for each remaining agent before starting its migration:

```markdown
### <Agent Name> (<product id>)

**Setup workflow**
| # | Step | Tier | Tools | Output |
|---|---|---|---|---|

**Recurring workflow**
| # | Step | Tier | Tools | Resume semantics |
|---|---|---|---|---|

**BaseAgent subclasses needed:** <list, with modelPolicy tier per one>
**New tools needed (if any):** <list, and justify why shared registry doesn't cover it>
**Gates needed:** <list>
**Eval dataset status:** <not started / N of 20 scenarios written / golden run endorsed>
```

---

## 5. Rollout order and rationale

**Update (post RFC-09/10): the SEO & GEO recommendation actuator is not on this table, and should not wait for it.** This table is the rollout order for *migrating content-writing agents onto agent-engine* — a real but lower-urgency workstream, because every agent on it (X aside) currently has **zero pilot clients**; nobody is losing value while they wait their turn. SEO & GEO is different: it already serves real, paying clients (RFC-04's own definition of done cites two proven ones), its scoring/recommendation layer already ships in `karosCMO` today, and the one piece that is missing — an actuator that turns an approved recommendation into an actual improvement (RFC-09 §1's "Phase 7") — is a live, client-visible value gap *right now*, not a future migration nicety. Recommendation: treat RFC-09/10 as its own workstream, prioritized **above** this entire table, and sequence it in two tiers rather than by agent:

- **Ship now, directly against the current karosCMO codebase — do not wait for the agent-engine core to exist.** The lowest-risk actuator path (`search.requestIndexing`, the `guided_manual` kit generator, and the scoped chat reusing the existing copilot infra) is plumbing-level work: no ReAct loop, no tool sandboxing, no BaseAgent needed. It can be built and shipped in days against the real repo, and it is the direct answer to "nothing is actually improving SEO/GEO yet."
- **Deliberately wait for more mature tooling before this one:** `cms.applyFix` (writing directly to a client's live WordPress/Shopify/Webflow site) is, as RFC-09 §5 says, the highest-risk tool in this entire document set — it is the one place agent-engine's write-fencing and gate discipline earns its keep. Rushing this ahead of that maturity is exactly the near-miss the karos-agents reference doc's own Finding 1 already lived through once.

The general lesson worth naming plainly: this whole document set (RFC-01 through RFC-10) is real, grounded specification work, but as of this note **none of it has shipped** — `agent-engine` is still scaffold-only. The next concrete action should be shipping RFC-09/10's low-risk slice, not writing an RFC-11.

| Order | Agent | Why here |
|---|---|---|
| 1 | **X (e13)** | Pilot. Already v2, single research connector, documented run-protocol to translate from. Proves the three-layer shape before anything else depends on it. |
| 2 | **LinkedIn (e10)** | Already rebuilt to v2 with a three-job split; most of its egress complexity is concentrated in the manager step, which is a clean fit for the "code execution over tool-result paging" pattern (RFC-01 §5, code-execution-with-MCP note). |
| 3 | **Reddit (e15)** | Per-slot semantics are the hardest case in the current system and are already well understood from prior debugging — good to tackle once the pattern from X/LinkedIn is proven, before the easier agents. |
| 4 | **Blog (e14) & Newsletter (e11)** | Heaviest carried legacy engine code; needs a proper rewiring pass but no unusual architectural risk. |
| 5 | **Instagram (e12) & TikTok (e16)** | Last, because of media-toolchain dependencies (video/image processing) and known egress complications (e.g. throttled fetch tools) that are better solved once the core pattern is stable elsewhere. |
| — | **CSO / Orchestrator (cross-client aggregation)** | Recommend converting these to pure workflows (Layer 1 + deterministic aggregation tools) rather than full `BaseAgent`-based agents — their value is aggregation, which is deterministic, plus one small judgment step. Flagged as a recommendation, confirm before building. |

Do this **one agent per sprint**, non-destructively, mirroring the "v2 alongside v1" pattern you already use: the new agent runs in shadow (or gated) mode until its evals and a side-by-side comparison against the legacy output clear, then traffic switches over per-agent.

---

## 6. Shared components to build once (don't rebuild per agent)

- Voice/brand derivation as a reusable `BaseAgent` step (only the craft skill it loads differs per platform).
- The research pull/freshness/fallback logic (`karos-research`) — one implementation, every agent's connector list is data, not code.
- The batch-review gate UI contract (RFC-01 §8.3) — one portal renderer for every agent's approval step.
- The eval harness scaffolding (golden run runner, judge invocation, CI gate) — parameterized per agent, not reimplemented.

---

## 7. Definition of done, per agent

An agent's migration is complete when:

- Its setup and recurring workflows run end-to-end on `agent-engine` and produce a `DynamicAgentRunReport`-shaped event stream the portal renders correctly.
- A run killed mid-flight resumes and loses only the in-flight slot (not the whole run).
- Its eval suite (20+ scenarios) passes both deterministic gates and the rubric judge at or above the agreed bar, with a golden run signed off by a human before cutover.
- A side-by-side comparison against the legacy `agent-service` output, on the same inputs, shows no quality regression and a *measured* (not estimated) cost per run.
- Traffic is switched over for that agent specifically, and the legacy skill is marked deprecated (not deleted — keep it until you're confident, then retire it).

## 8. Open questions to confirm per agent, before starting

1. Which of this agent's current connectors/fallback chains are still current vs. stale (mirrors the kind of drift already found across the corpus for other agents — worth a quick check per agent rather than assuming the existing prose is current).
2. Any agent-specific publish constraints or platform caps that need to become a typed tool rule (e.g. per-post pricing caps, per-24h publish limits) rather than a documented-but-unenforced number.
3. Whether this agent's eval rubric needs a platform-specific judge dimension beyond the shared voice/hook/convention set.
4. **Which portal agent-definition system is actually authoritative for this agent right now** — confirmed necessary specifically for X (RFC-01 §16.5): a `customAgents` document and a separate `dynamicAgentSpecId` both exist for "X Agent," and this session could not determine which one carries live traffic from the files read alone. Check this for every agent before assuming the contract described in RFC-01 §7 is the only one in play — don't guess, ask Shlomi.
5. **Whether the committed skill still matches what's actually deployed**, the way X's did not (RFC-01 §16.2: the committed `SKILL.md`/`references/` describe a batched run; the live, Firestore-embedded instructions override it to one-post-per-run, dated 2026-08-11). Check the actual `customAgents`/dynamic-agent-spec document's `instructions`/`prompt` fields against the committed skill for every agent before treating the git-committed version as ground truth — this migration is the forcing function that ends the drift for good (RFC-01 §16.1), but until it's done for a given agent, the deployed prompt wins any disagreement.

---

*Use this document alongside RFC-01. Recommended framing for each migration session with Claude Code: "Migrate <agent name> per RFC-02 §2's recipe, using RFC-01's BaseAgent and tool registry — start from the step table in §3/§4 for this agent."*
