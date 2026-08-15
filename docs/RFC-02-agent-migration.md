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

## 3. Reference worked example: X Agent (e13), end to end

X is the recommended pilot: it's already the most rebuilt agent in the current system, its research leg is a single connector (so the pilot isn't gated on multi-connector tool work), and it already has a documented run-protocol to translate from.

### Setup workflow (runs once per client)

| # | Step | Tier | Tools | Output |
|---|---|---|---|---|
| 1 | Load intake | code | `client.getProfile`, `client.getExecutives` | Resolved seats + company handle |
| 2 | Validate intake | code | `gate.intakeComplete` | Hard gate: no handle, no seat |
| 3 | Derive voice | agent, bounded | skill: voice-craft | Voice profile per seat |
| 4 | Seed topic catalog | agent, bounded | `research.pull`, `topics.topUp` | Catalog with ~2 weeks of runway |
| 5 | Write setup outputs | code | `ledger.upsertBrief`, `client.writePolicy` | Persisted client policy + brief |

### Recurring producer workflow (per run)

| # | Step | Tier | Tools | Resume semantics |
|---|---|---|---|---|
| 1 | Intake & angle | code | `client.getConfig` | Pure, always recomputed |
| 2 | Assemble context | code | `client.*`, `memory.read` | Cached per run |
| 3 | Research pull | agent, bounded | `research.pull`, `research.checkFreshness` | One pull serves all slots |
| 4 | Write research run | code | `research.writeRun` | Requires a `pull_id` |
| 5 | Plan slots | code | `topics.reserve` | Slot ids assigned here |
| 6..N | Draft, gate, revise once — **per slot** | agent per slot | craft skill, `gate.*` | Per-slot checkpoint |
| N+1 | Assemble batch | code | `render.*` | — |
| N+2 | **Batch review gate** | gate | typed payload | Timeout → escalate to PM |
| N+3 | Deliver | code | `ledger.writeDeliverable`, `ledger.appendEvent`, `ledger.upsertBrief` | Idempotent on `(run_id, slot_id)` |
| N+4 | Learn | code | `topics.commit`, `memory.appendDecision`, `ledger.feedbackAppend` | **Runs after the gate, by construction** |

**What doesn't change for the person configuring this in the Studio:** the five questions they've always asked about an agent — what does it read, what can it publish, what needs my approval, can I still change its voice by talking to Claude, what did it decide and why — all still have answers, and question four gets a *better* answer than today: craft rules, voice, formats and judgment stay in Markdown editable by talking to Claude; what moves to code is the plumbing nobody was hand-editing anyway. State this explicitly when you present the migrated agent — it's the objection that stalls agent rebuilds when it isn't addressed up front.

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

---

*Use this document alongside RFC-01. Recommended framing for each migration session with Claude Code: "Migrate <agent name> per RFC-02 §2's recipe, using RFC-01's BaseAgent and tool registry — start from the step table in §3/§4 for this agent."*
