# RFC-01: Agent Engine Core — BaseAgent, Runtime & Tool Layer

**Project:** `agent-engine` (new repository)
**Status:** Draft for implementation — hand this document to Claude Code to begin Phase 1
**Author:** Drafted for Tomer Erel / Karos Labs
**Depends on:** none (this is the foundation). RFC-02 (Agent Migration Playbook) depends on this.

---

## 0. Executive summary

`agent-service` today is a prompt-chaining runner: a `SKILL.md` file describes a procedure in prose, and a Claude session is told to follow it, using the filesystem as state and JSONL files as records. It works, and the skill library behind it (`karos-agents`) is unusually well documented — but the *runtime* under it cannot be tested, cannot be resumed precisely, cannot report partial progress, and cannot cheaply swap models on a per-step basis. Every one of those is a runtime property, not a prompt-quality property, so no amount of better prompting fixes it.

This RFC defines a new, standalone engine — **`agent-engine`** — built around three cleanly separated layers:

1. **Orchestration (code).** A durable workflow per run owns identity, checkpoints, retries, budget and human gates.
2. **Agent steps (`BaseAgent`).** Where judgment is needed, a bounded ReAct loop with a narrow tool set and a typed output schema — this is the class every concrete agent (`XAgent`, `LinkedInAgent`, `ResearchAgent`, …) inherits from.
3. **Tools (MCP).** Every external read, every ledger write, every gate, every dedupe reservation is a typed, tested, versioned tool. Agent steps and workflow code both call the same tools — nothing talks to the outside world any other way.

The rule that makes the layering hold: **Layer 2 has no I/O except through Layer 3, and Layer 1 has no judgment except through Layer 2.**

`agent-engine` is built as its own repository so that you can point traffic at it agent-by-agent as each migration lands, without destabilizing `agent-service` while it's still serving the agents that haven't moved yet.

---

## 1. Scope, repo strategy, and relationship to existing systems

### 1.1 New repository: `karoslabs/agent-engine`

**Decision:** build this as a new, separate git repository, not a folder inside `karosCMO`. Reasons:

- **Independent release cadence.** The engine needs its own CI, its own versioning, and its own deploy pipeline (containers running the orchestration workers and the MCP tool servers) that shouldn't be coupled to `karosCMO`'s portal release cycle.
- **Clean cutover story.** You asked for the ability to "start routing requests to it" as each piece is ready. That's much easier to reason about, demo, and roll back when it's a separate deployable with its own version tag, rather than a branch of behavior inside the existing runner.
- **Investor / diligence legibility.** A named, standalone "agent runtime" repository with its own README, architecture doc and eval dashboard reads as a real platform asset. A folder inside the marketing product's monorepo does not.
- **Still one language, one org.** It stays TypeScript on Node 22 LTS, published as private npm packages if `karosCMO` needs to import types, so there is no polyglot cost — only the normal cost of a second repo (which is one more CI pipeline and one more version to bump).

If your team strongly prefers a monorepo (e.g. Turborepo/Nx workspace spanning `karosCMO`, `agent-service`, and `agent-engine`) that is also reasonable and preserves everything below — just replace "repository" with "package" throughout. The default recommendation here is **separate repo**, per your stated preference.

### 1.2 Relationship to `agent-service` (legacy runner)

`agent-service` keeps running unmodified for every agent that hasn't migrated yet. `agent-engine` is stood up alongside it. Cutover is **per-agent, not big-bang**:

- The portal (or a thin routing layer in front of it) decides, per product/agent, whether a run goes to the legacy runner or to `agent-engine`.
- `agent-engine`'s tool layer (Layer 3) is built first and is useful on its own — it can even be called *from* the legacy skills during a transition window, so the migration doesn't have to be all-or-nothing per agent.
- `agent-service` is retired agent-by-agent as each one's `agent-engine` implementation passes its evals and shadow-runs cleanly. It is decommissioned last, not first.

### 1.3 Relationship to `karos-agents` (the skill library)

Skills do not disappear. They stop being the runtime and become the **craft policy layer** — exactly the part they're actually good at: voice, tone, format rules, hook shapes, worked examples, and client-specific learned rules. A `BaseAgent` step loads the relevant skill (or the relevant slice of it) as its system-prompt content via Claude's Agent Skills primitive (progressive disclosure), the same way it does today, but it is no longer what decides control flow, retries, or state. The `products/` vs `clients/<slug>/skills/` split you already maintain survives unchanged.

### 1.4 Relationship to the karosCMO portal / Dynamic Agent Studio

This is the integration surface you explicitly care about, so it gets its own section (§7) below. In short: `agent-engine` emits a step-level event stream shaped to match the portal's own `DynamicAgentRunStep` / `DynamicAgentRunReport` model — which is already the most advanced state-tracking concept in the current codebase — so the existing progress UI (`dynamic-agent-step-progress`, `job-transcript`) can render real `agent-engine` runs with little to no UI rework, and can eventually become the single run model the whole portal renders (replacing the separate "custom agent" and job-status code paths).

### 1.5 A note on how this document was produced

This spec is written from three sources: (a) your own description of the target architecture and the Gemini proposal you shared, (b) a detailed internal architecture audit of the live `karosCMO` / `agent-service` / `karos-agents` codebase produced earlier this week (dated 12 Aug 2026), which names real files, real contracts, and ten specific structural bugs in the current runtime, and (c) a direct, targeted read of the actual `karosCMO` repository (via the connected device folder) covering `src/lib/types.ts`, `dynamic-agent-generation.ts`, `dynamic-agent-validation.ts`, `agent-service/src/state/*`, `agent-service/src/config.ts`, and `.env.example`. That direct read confirmed most of (b) and corrected a few specifics that now drive this document — most importantly: `karosCMO`'s database is Firestore only (no Postgres anywhere in the stack today), `agent-service`'s own job queue runs on Redis (not Firestore, not Postgres), and the `DynamicAgentStepDef` / `DynamicAgentRunStep` contracts are real, already shipping code (not just a portal mockup) — see the corrected §7 and §8.4a. Neither `agent-service`'s `runner/src/dynamic/` internals nor the `karos-agents` skill repository itself were read directly in this pass (the former wasn't needed for this RFC's decisions; the latter is a separate, not-yet-connected repository) — worth a quick sanity check by Shlomi on §7's exact runner behavior before Claude Code starts building against it.

---

## 2. Goals and non-goals

**Goals**

- A `BaseAgent` class with a real, bounded, testable agent loop (Reasoning → Action → Observation → Evaluation), not a prose script.
- Every concrete agent is a small class extending `BaseAgent`, adding only its own tools, prompt, and output schema — "half an hour to add a new platform agent."
- Model-agnostic where it's safe, and pinned where it isn't (§5.4) — the point is real leverage over cost and resilience, not a religious commitment to provider-neutrality that quietly degrades quality.
- A shared, typed, tested Tool Registry (MCP) that both the new engine and (temporarily) the legacy runner can call.
- Durable, resumable, per-step checkpointed runs — killing a run loses at most the in-flight unit of work, not the whole run.
- Full step-level telemetry: tokens, cost, model, duration, tool calls — per client, per product, per step.
- A real evaluation harness so that swapping a model, a prompt, or a tool version is a measured decision, not a vibe.
- A design that a technically sophisticated investor or engineering diligence reviewer would recognize as a genuine agentic platform, not a wrapper around prompt templates.

**Non-goals (for this RFC)**

- Rewriting craft/voice content. Skills stay Markdown, stay human-editable, stay the thing your team edits by talking to Claude.
- Picking a single "cheapest model" and routing everything to it. §5.4 explains why that's a false economy for this workload.
- A full migration of every agent in one push. That's RFC-02's job, and it's phased.
- Standing up Temporal (or equivalent) on day one. §8 recommends starting lighter and upgrading when the phase-1 pilot proves the layering is right.

---

## 3. Technology stack

| Concern | Choice | Rationale |
|---|---|---|
| Language / runtime | **TypeScript, Node 22 LTS** | Matches `karosCMO` / `agent-service` exactly. No polyglot cost, no duplicated types, one CI toolchain. |
| Agent step runtime | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), self-hosted | This is what `BaseAgent` is built on. Gives you subagents (per-slot isolation), hooks (`PreToolUse` for the write-fence), permission modes, and native prompt caching — all provider-specific features you actively want and would lose behind a generic abstraction layer (see §5.4). |
| Mechanical / structured steps | **Anthropic Messages API + Tool Runner** (`client.beta.messages.tool_runner`), plus a thin internal `ModelRouter` for non-pinned tiers | Cheap, boring, testable; supports structured output via JSON Schema without needing a full agent loop for classification/ranking/extraction work. |
| Multi-provider routing (portable & commodity tiers only) | **A small internal `ModelRouter` interface** (`llm.complete(prompt, schema, tier)`) with adapters for Anthropic (direct + Vertex), OpenAI, DeepSeek, and one open-weight route via a **self-hosted LiteLLM** gateway | Deliberately *not* a heavyweight abstraction like LangChain, and deliberately scoped to only the step tiers where provider-swapping is safe. See §5.4 for why pinned/creative steps go directly to the Agent SDK instead. |
| Tool transport | **MCP, 2026-07-28 spec**, HTTP, one deployment | Stateless requests (server scales behind a load balancer with no shared session state), a `tasks/` extension for long-running tool calls (video render, scrape), multi-round trips (`input_required` / `inputResponses`) for mid-call human confirmation, and header-based tenant routing at the edge. |
| Schema / validation | **Zod** | Every tool input/output, every workflow step output, every gate verdict is a Zod schema. Generate docs from the schema, not the other way around. |
| Orchestration / durable workflow | **Firestore-backed durable step store** to start (revised — see §8.4a); **Temporal** as the target once the pilot proves the layering (see §8) | Matches the "add durable orchestration when workflows exceed ~30s, touch 3+ external systems, or pause for multi-hour/multi-day approvals" threshold — which describes every recurring agent you have. Starting on Firestore means zero new infrastructure: it's already the sole database behind `karosCMO` (`src/lib/data.ts`, Admin-SDK-only, `firestore.rules` denies direct client access), so the engine's run/slot/step records are just more Firestore documents, in the same access pattern your team already operates. |
| State / checkpoints | One Firestore document per run, one per slot, written before advancing; document ID is the idempotency key (`run_id`/`slot_id`/`kind`) | Engine-level resume by construction, not by "list the folder and find the lowest missing number." A `set(..., {merge: true})` on a deterministic doc ID gives idempotent writes for free — no separate compare-and-set layer needed for this store. |
| Lightweight locks / pub-sub (optional) | **Reuse the existing Redis instance** (`agent-service` already runs one for its job queue — see `agent-service/src/state/jobs-store.ts`) for cancellation signals and one-writer-per-row locks | Zero new infrastructure here either. Firestore stays the durable system of record; Redis is only ever a fast, ephemeral coordination layer on top, exactly the role it already plays for `agent-service`. |
| Memory | `karos-memory` MCP tool — **retrieve, don't load whole** | Structured records (beliefs, hypotheses, decisions, skill changelog) with a token-capped "standing beliefs" slice always in context, everything else fetched by relevance. Markdown stays as a generated, human-readable view, not the database. |
| Evals | **Vitest** harness under `agent-engine/evals/`, golden runs + deterministic gate assertions + LLM-as-judge | See §10. |
| Observability | **OpenTelemetry**, one span per workflow step and per tool call, tagged `run_id`, `client`, `product`, `slot_id`, `tool_version`, tokens, cost | The Agent SDK already surfaces per-turn usage; hooks are the instrumentation point. |
| GCP-specific | **Vertex AI as a second route to the same Claude models** (redundancy, not arbitrage) — recommended to wire up at production cutover, since you're already targeting GCP and it costs nothing in quality; **Firestore or Postgres** for checkpoints, pick whichever your ops team already runs | See §11. Vertex is not a reason to use a different model family — it's a second network path to the *same* model, protecting against provider/region incidents. |

**Explicitly rejected for this project:**

- **LangGraph** — mature, but it's a second agent framework and a second prompt runtime running alongside the Agent SDK, for no benefit given your stack is already Anthropic-native.
- **OpenAI Agents SDK** — would mean re-homing your skill library onto a different vendor's agent format for no gain here.
- **A universal LLM gateway (OpenRouter/Portkey) in front of every call, including pinned steps** — this is the "arbitrage everything" trap: it breaks prompt caching (cache is per-model, per-endpoint, and invalidated the moment tool definitions or models get shuffled), and for an agent-loop workload, input tokens dominate cost far more than the per-token price difference between vendors. Use a gateway (LiteLLM, self-hosted) *only* behind the portable/commodity tiers described in §5.4, never in front of a pinned step.

---

## 4. Three-layer architecture

```
                    ┌───────────────────────────────────────────────────────────┐
 portal / schedule  │        LAYER 1 — ORCHESTRATION (durable workflow, code)    │
 run button / cron   ─▶│  run identity · slot identity · checkpoints · retries   │
                    │  budget enforcement · ordering · gates as awaited signals  │
                    └───────────────────────────────┬───────────────────────────┘
                                     │ calls                        │ awaits
                                     ▼                               ▼
                    ┌───────────────────────────┐   ┌───────────────────────────┐
                    │   LAYER 2 — AGENT STEPS    │   │        HUMAN GATE          │
                    │   BaseAgent (bounded loop) │   │  typed payload, timeout,   │
                    │   narrow allowedTools      │   │  escalation                │
                    │   typed output schema      │   └───────────────────────────┘
                    │   one subagent per slot    │
                    └───────────────┬───────────┘
                                     │ only I/O
                                     ▼
                    ┌───────────────────────────────────────────────────────────┐
                    │        LAYER 3 — TOOLS (MCP servers, typed, tested)        │
                    │  karos-client · karos-research · karos-topics             │
                    │  karos-gates · karos-ledger · karos-memory · karos-publish │
                    └───────────────────────────────┬───────────────────────────┘
                                     │                               │
                              lab adapter                      prod adapter
                          (files + git, dev)             (platform APIs, GCP)
```

**The invariant that must hold for this to work:** Layer 2 (`BaseAgent`) never touches the filesystem, an external API, or a database directly — every external effect goes through a Layer 3 tool. Layer 1 (the workflow) never makes a judgment call about content — anything requiring reasoning is delegated to a Layer 2 step. This is what makes tool calls testable in isolation, makes workflows replayable without re-running expensive model calls, and is the single design rule that prevents this rebuild from reintroducing the same class of bug the current system has (untestable behavior baked into prose).

---

## 5. `BaseAgent` — detailed specification

This is the class every concrete agent inherits from, and the piece you specifically asked for.

### 5.1 Core interfaces

```typescript
export interface AgentContext {
  runId: string;
  clientSlug: string;
  productId: string;
  slotId?: string;          // set when this step is one unit of a fan-out
  runKind: "setup" | "recurring" | "manager" | "orchestrator";
  metadata: Record<string, unknown>;
}

export type ProviderPolicy = "pinned" | "portable" | "commodity";

export interface ModelPolicy {
  policy: ProviderPolicy;
  model: string;             // e.g. "claude-opus-4-6", "claude-sonnet-5", "gpt-4o-mini"
  fallbackModel?: string;    // used only for "portable" / "commodity" policies
}

export interface AgentStepConfig<TOutput> {
  id: string;                       // e.g. "draft-post", "derive-voice"
  description: string;
  allowedTools: string[];           // narrow, explicit MCP tool names
  outputSchema: ZodSchema<TOutput>; // typed terminal output
  maxSteps?: number;                 // default 8
  modelPolicy: ModelPolicy;
  skillRef?: string;                 // craft-policy skill this step loads
  selfCritique?: {
    gateTool: string;                // e.g. "gate.brand_compliance"
    maxRevisions?: number;           // default 1
  };
}

export interface AgentStepTelemetry {
  stepIndex: number;
  thought?: string;
  toolCall?: { name: string; args: unknown; result: unknown; toolVersion: string };
  modelUsed: string;
  inputTokens: { cached: number; uncached: number };
  outputTokens: number;
  durationMs: number;
  costUsd: number;
  status: "success" | "content_fail" | "tooling_error";
}

export interface AgentExecutionResult<TOutput> {
  finalOutput: TOutput | null;
  steps: AgentStepTelemetry[];
  totalCostUsd: number;
  totalTokens: { input: number; output: number };
  status: "completed" | "content_fail" | "tooling_error" | "budget_exceeded";
}
```

### 5.2 `BaseAgent` responsibilities

```typescript
export abstract class BaseAgent<TOutput> {
  protected abstract config: AgentStepConfig<TOutput>;

  async run(ctx: AgentContext, input: unknown): Promise<AgentExecutionResult<TOutput>> {
    // 1. Resolve model + provider for this step from config.modelPolicy (§5.4)
    // 2. Load skillRef content (craft policy) into the system prompt, if set
    // 3. Open a Claude Agent SDK subagent scoped to ctx.slotId, with:
    //      - allowedTools = config.allowedTools only
    //      - a PreToolUse hook enforcing the tenant write-fence (§9)
    //      - permissionMode: "dontAsk" (service mode)
    // 4. Run the ReAct loop (§5.3), capped at config.maxSteps
    // 5. If config.selfCritique is set, call the gate tool on the draft output;
    //    on content_fail, revise once (bounded by maxRevisions), never rewrite silently
    // 6. Validate the terminal output against config.outputSchema
    // 7. Return AgentExecutionResult with full step telemetry
  }
}
```

### 5.3 The ReAct loop

A standard, bounded loop, matching what you described, made concrete:

1. **Thought** — the model decides the next action toward the step's goal, given the accumulated observations so far.
2. **Action** — the model calls exactly one tool from `allowedTools`, with arguments validated against that tool's Zod input schema before execution.
3. **Observation** — the tool's typed result (or typed error — see §6's error taxonomy) is appended to context.
4. **Evaluation** — the loop checks: has the output schema's terminal condition been met? Has `maxSteps` been hit? Did the tool call fail with `tooling_error` (in which case the run is marked `degraded`, never silently treated as a content failure)?

`maxSteps` defaults to 8, per step config, to bound runaway loops and token spend — this is a budget control, not a suggestion, and step 5.5 below enforces it independently of the model's own judgment about whether it's "done."

### 5.4 Model-agnostic execution — the three-tier provider policy

This is where "we can swap models when we need to" gets implemented properly, and it's more nuanced than routing everything through one abstraction layer. In an agent loop, **input tokens dominate cost** (every turn re-sends the whole conversation so far), and Anthropic's prompt cache read discount (90%) is currently roughly double what OpenAI/Azure offer. That means naive "route every call to whatever's cheapest this week" **can raise total cost while lowering quality**, because it breaks the cache on every switch and loses Agent-SDK-only features (skills, subagents, hooks) that the drafting/creative steps depend on.

So every `AgentStepConfig` declares one of three policies:

| Policy | Used for | How it's wired | How fast you can switch |
|---|---|---|---|
| **`pinned`** | Drafting, brand voice judgment, anything a client will read, the self-critique gate | Agent SDK, direct to Anthropic, cache-optimized, skills loaded, never routed through a gateway | Only as a deliberate project (e.g. evaluating a new frontier model release) |
| **`portable`** | Summarization, structured extraction, the relevance ranker, research pre-aggregation | Thin internal interface: `llm.complete(prompt, schema, tier)` — same call shape regardless of backing model | A config change plus one eval run |
| **`commodity`** | Embeddings, classification, dedupe/similarity, transcription, boolean judgments | Routed to whatever passes evals and is cheapest that week (Anthropic Haiku, DeepSeek, Qwen, GPT-4o-mini, etc.), behind the self-hosted LiteLLM gateway | Immediately, per call |

`ModelPolicy.policy` plus `ModelPolicy.model`/`fallbackModel` on each step is the whole mechanism. No tool, workflow, or agent ever hardcodes "call Claude" — it declares its tier and the router resolves the rest. This gives you real leverage (a strategy step can run on a frontier reasoning model while its tool calls run on Haiku-class models) without pretending that every step is equally safe to swap, which is the mistake a blanket "just use an AI SDK abstraction for everything" approach makes.

**Vertex AI's role here:** Vertex is not a fourth tier — it's a second *route* to the same pinned models, for redundancy against an Anthropic API incident or regional outage. Wire it up at production cutover (§11), not as part of model-swapping.

### 5.5 Tool invocation and sandboxing

- Each fan-out unit of work (one platform draft, one competitor lookup, one voice derivation) runs as its own **Claude Agent SDK subagent**. The subagent's only channel to its parent is the prompt in and the typed return value out — this is exactly the isolation a fan-out step needs, and it's what makes per-slot retry and per-slot cost attribution possible.
- `allowedTools` is always the narrow, explicit list from `AgentStepConfig` — never a blanket `Bash(*)` or unrestricted tool surface.
- A `PreToolUse` hook runs before every tool call and enforces the write-fence (§9) and the per-run budget ceiling (§10) — this runs in code, before permission evaluation, and can block the call outright.

### 5.6 Self-correction / quality gate

A real agent does not hand its output straight back — but "self-critique" is implemented as **a mandatory call to a typed gate tool**, not a free-text "please check your work" instruction. Every gate tool (`gate.brand_compliance`, `gate.no_placeholder`, `gate.lint_post`, `gate.numbers_sourced`, …) returns exactly one of:

```typescript
type GateVerdict =
  | { verdict: "pass"; evidence: string[]; toolVersion: string }
  | { verdict: "content_fail"; evidence: string[]; reason: string; toolVersion: string }
  | { verdict: "tooling_error"; reason: string; toolVersion: string };
```

Two rules, non-negotiable, because they were the source of real bugs in the prose-based version of this system: **a gate never silently rewrites its input** — on `content_fail` it returns to the producer with the reason, and the producer revises (bounded by `maxRevisions`); and **a `tooling_error` is never recorded as a content verdict** — the run is marked `degraded`, which is visibly different from a passing or failing piece of content.

---

## 6. Error taxonomy and run outcomes

Every tool call and every gate returns one of three typed outcomes, everywhere in the system:

- **`content_fail`** — the content or data is wrong/non-compliant; this is real signal, worth learning from.
- **`tooling_error`** — something broke (network, auth, malformed response); never mistaken for a content judgment.
- **`not_available`** — the requested data legitimately doesn't exist yet (e.g. a research leg not yet run).

And every run resolves to one of four outcomes: `completed`, `failed` (content-level), `degraded` (a fallback/tooling gap occurred but the run produced usable output — record and surface it, don't silently pretend it's a clean pass), and `awaiting_gate` (blocked on a human decision). Four outcomes, not three — most systems collapse `degraded` into `completed` and lose the signal.

---

## 7. Integration contract with the karosCMO portal / Dynamic Agent Studio

This section was verified directly against `src/lib/types.ts` and `src/lib/dynamic-agent-generation.ts` in the live `karosCMO` repo (not just inferred), so the shapes below are exact, not illustrative.

### 7.1 What already exists — this is real, shipping code, not a mockup

- **`DynamicAgentSpec`** — an admin-authored agent definition (`docs/en` "Agent Studio"), with `inputSchema: DynamicAgentInputDef[]` (client-facing intake fields: `key`, `type: "text"|"textarea"|"file"|"image"|"select"`, `label`, `helpText`, `required`, `order`, plus placeholder/options/accept/maxSizeMb) and `steps: DynamicAgentStepDef[]`.
- **`DynamicAgentStepDef`** — a discriminated union on `type: "ai" | "code"`. An AI step carries `id`, `label`, `model: "opus" | "sonnet" | "haiku"` (a **model alias**, not a raw model id — see §7.3), `prompt` (Markdown, composed with serialized run context at execution time), and `order`. **v1 is sequential-only**: `dependsOn` exists in the schema for a future DAG mode, but the current runner (`agent-service/runner/src/dynamic/step-runner.ts`) executes `steps` strictly in `order`.
- **`DynamicAgentJobPayload`** — the frozen brief a run actually executes against: `specId`, `specVersion`, `specSnapshot: DynamicAgentSpec` (the spec is snapshotted at submit time, so a later spec edit never changes an in-flight run), `clientId`, `inputs`, and `stepModels?: Record<string, string>` (a per-step model override, keyed by step id, that the runner prefers over the snapshot's own `step.model` — see `resolveStepModel()` in the dynamic step runner).
- **`DynamicAgentRunStep`** (persisted, per executed step) — `stepId`, `type: "ai"|"code"`, `label`, `status: "done"|"failed"` (binary today — no in-between state yet), `durationMs`, `model?` (the concrete model actually used, for staff-facing audit), `error?`.
- **`DynamicAgentRunReport`** — `specId`, `specVersion`, `steps: DynamicAgentRunStep[]`, `failedStepId?`, `failedStepIndex?`, `hasPartialOutput?` (true when earlier steps produced output the client can still be shown), plus a `DynamicAgentGuardrailReport` (forbidden-topics enforcement, actually exercised this run) and a `DynamicAgentDedupeReport` (trigram-Jaccard similarity vs. this client's history) when those opt-in features are on.
- The job record carries `dynamicAgentSpecId` and `dynamicRun: DynamicAgentRunReport` directly, alongside the standard `JobStatus` (`queued → running → review → approved → delivered`, or `failed`/`cancelled`).
- There is already a **cost-attribution reshape** of this exact step list happening for the "Job Control Room" ( `step-breakdown.ts`'s `buildStepBreakdown`, cited in `types.ts`), which adds a `costUsd` per step for the dynamic-agent path specifically — confirming per-step cost telemetry is a validated, in-progress direction in the real codebase, not a speculative addition here.

**In short: `agent-engine`'s target step model (RFC-01 §5–§6) is not competing with an idea in this codebase — it is the natural, harder engine sitting underneath a contract that already exists and is already partially wired up.** The recommendation below is correspondingly sharper than "design something compatible": it's to make `agent-engine` the actual execution engine behind this contract.

### 7.2 The integration move

- `agent-engine`'s Layer 1 workflow, for any run submitted through Dynamic Agent Studio, consumes the same `DynamicAgentJobPayload` (`specSnapshot`, `inputs`, `stepModels`) the portal already builds via `submitDynamicAgentJob`. No new payload shape is needed on the portal side.
- Each `DynamicAgentStepDef` of `type: "ai"` becomes exactly one `BaseAgent` step (Layer 2); each `type: "code"` step becomes a deterministic Layer 1 step. This is a direct, one-to-one mapping — not a reinterpretation.
- `agent-engine` emits `DynamicAgentRunStep` records unchanged in shape, with two **additive** fields the portal can ignore until its UI catches up: `costUsd` (already validated as a direction per §7.1) and `tokensIn`/`tokensOut` (cached/uncached split, per RFC-01 §11).
- The existing binary `status: "done"|"failed"` on a step is kept as-is for the portal-facing contract. `agent-engine`'s richer internal taxonomy (`content_fail`/`tooling_error`/`not_available`, RFC-01 §6) collapses to `"failed"` at this boundary, with the detail carried in `error` — this avoids a breaking change to a contract already in production, while giving your own team (not the portal's UI, but anyone reading logs/telemetry) the fuller picture.
- **Guardrails and dedupe map directly onto `agent-engine`'s gate/tool concepts**: the topic-guardrail verification pass becomes a `gate.brandCompliance`-style typed tool call (RFC-01 §5.6), and the dedupe score becomes a `commodity`-tier similarity tool call in `karos-topics` (RFC-01 §5.4/§9.2) — meaning these two already-shipped safety features are not lost in the migration, they become instances of the general pattern instead of Dynamic-Agent-Studio-specific code.
- **`stepModels` becomes the per-run override channel for `ModelPolicy`** (RFC-01 §5.4): resolve it exactly as today (runner prefers `stepModels[stepId]` over the snapshot's own `step.model`), but resolve the alias (`opus`/`sonnet`/`haiku`) through `agent-engine`'s `ModelRouter` rather than a hardcoded lookup, so a future model swap (e.g. a new Sonnet generation) is a router config change, not a find-and-replace across specs.

### 7.3 Model alias resolution — align with the tiers already implied in the real prompt guidance

`dynamic-agent-generation.ts`'s own generation prompt already documents the intended tiering almost exactly as RFC-01 §5.4 independently proposed: *"haiku for extraction/sorting/classification; sonnet for writing and judgement; opus ONLY when the phrasing itself is the product."* Carry this forward directly rather than inventing new tier names:

| Studio alias | RFC-01 `ProviderPolicy` | Notes |
|---|---|---|
| `haiku` | `commodity` | Classification, extraction, sorting, dedupe similarity |
| `sonnet` | `pinned` | The default for writing and judgment — this is the tier that reaches a client, so it stays pinned, not routed |
| `opus` | `pinned` (premium) | Reserved for when exact phrasing is the deliverable itself — never a default upgrade |

This means the Studio UI's existing three-option model picker needs **no change** — `agent-engine` just resolves those same three aliases more rigorously underneath.

### 7.4 What doesn't change for the person configuring an agent in the Studio

They still define stages, the input they want from the client, and per-stage prompts — that authoring experience is unchanged. What changes is that a "stage" now corresponds to one real, typed workflow step (Layer 1) or agent step (Layer 2) with real per-step cost and durability instead of a single long, unresumable model session, so the Studio's own progress view (already built to show step-by-step progress) becomes accurate under load — including resuming a run that dies mid-step, which the current sequential-only runner cannot do today.

### 7.5 Open item, not assumed

Whether the portal's two separate agent-definition systems — the older hardcoded `custom-agents` path and the newer `dynamic-agent-*` path — should eventually merge onto this one step model once `agent-engine` is live is a real product-roadmap decision with its own cost. The direction in this RFC makes that merge easier (both paths would sit on the same step contract), but doing the merge itself is out of scope here and shouldn't be assumed.

---

## 8. Orchestration layer (Layer 1)

### 8.1 What the workflow engine owns

- **Run identity** — `run_id`, `client_slug`, `product_id`, `run_kind`, `cadence_date`, assigned once, passed as arguments, never re-derived by a model from a process id or restated in text.
- **Slot identity** — when a run fans out to N items (N platform drafts, N competitors), the engine creates N slots up front with positional ids. Per-slot state, per-slot retry, per-slot outcome.
- **Checkpoints** — every step's typed output is persisted before the next step starts. Resume is engine-level, not "list a folder and find the lowest missing number."
- **Retries and compensation** — a per-step retry policy that distinguishes transient failure (retry), content failure (return to the producer step with evidence), and tooling failure (mark the run `degraded`, don't record it as a content verdict).
- **Gates** — `await gate({kind, payload, timeout, escalateTo})`. A multi-day wait does not hold a process open.
- **Budget** — a per-run token/dollar ceiling enforced *before* each agent step runs, not audited after the fact.
- **Ordering** — for anything with a "one writer per row" requirement (e.g. only one workflow may write a given ledger snapshot for a given product), that's a property of the workflow graph, not a convention someone has to remember.

### 8.2 Illustrative workflow shape (not final — refined per-agent in RFC-02)

```typescript
workflow producerRun(ctx: {runId, clientSlug, productId, cadenceDate}) {
  intake   = step.code(loadIntake)                    // seat vs company, resolved once
  context  = step.code(assembleContext)                // profile, brand, voice, memory
  research = step.agent(PullAndPickStep, {schema: Anchors})
  slots    = step.code(planSlots(research, config))    // positional ids assigned here
  drafts   = fanout(slots, slot =>
               pipeline(
                 step.agent(DraftStep, {schema: Draft, tools: [craftSkill, renderPreview]}),
                 step.code(gate.lint + gate.noPlaceholder),
                 step.agent(ReviseIfContentFail, {maxRevisions: 1}),
               ))
  batch    = step.code(assembleBatch(drafts))
  approval = step.gate({kind: "batch_review", payload: batch})
  deliver  = step.code(ledger.writeDeliverable + ledger.appendEvent + ledger.upsertBrief)
  learn    = step.code(topics.commit + memory.appendDecision + ledger.feedbackAppend)
}
```

Note where the human gate sits relative to `learn`: because the gate is an awaited signal in a durable workflow rather than a blocking process, `learn` runs *after* resume, by construction — not something that has to be remembered as a rule.

### 8.3 Gate contract (one shape for the whole system)

```typescript
interface Gate {
  kind: "brand_confirm" | "batch_review" | "policy_change" | "publish_approve" | "connect_credential";
  runId: string;
  slotId?: string;
  payload: unknown;          // typed per kind, portal renders without special-casing
  requiredRole: string;
  timeout: { duration: string; onTimeout: "hold" | "auto_approve" | "escalate" };
  response?: { decision: "approve" | "reject"; actor: string; reason?: string; at: string };
}
```

A reason is mandatory on rejection (this is what feeds the learning loop), and a timeout means a forgotten gate is visible rather than a run that's silently stuck forever.

### 8.4 Engine choice — decision, not a default

| Option | Fit | Against |
|---|---|---|
| **Temporal** | Target. Signals map directly onto the `await gate(...)` mechanism including multi-day waits. Full event-history replay is a genuinely better debugging tool than the "read the run folder" approach it replaces. Proven at scale you'll likely never reach — which is the point, it won't be the bottleneck. | Real operational surface: workers, namespaces, versioning discipline, and its own persistence layer (see §8.5). Non-trivial for a small team. Temporal Cloud has a cost. |
| **Firestore-backed durable step store** (recommended starting point — revised, see §8.4a) | Zero new infrastructure: it's the only database `karosCMO` runs today. Document-per-run and document-per-slot with deterministic IDs gives idempotent writes natively. Matches the multi-tenant access pattern you already enforce (`firestore.rules` denies direct client reads/writes; everything goes through `src/lib/data.ts`'s Admin SDK). | Weaker replay/versioning story than Temporal; long human gates are workable (a document field plus a scheduled check) but less elegant than native signals; no native multi-document ACID transaction across an unbounded number of slots (workable at the fan-out sizes these agents actually use — tens of slots, not thousands). |
| **Postgres-backed durable step table** | A reasonable *later* upgrade once Firestore's document-transaction model becomes limiting, or once Temporal is adopted and needs its own persistence layer anyway (see §8.5) | Extra infrastructure to stand up and operate that the stack doesn't currently have, for no benefit until you actually hit Firestore's ceiling. |
| **Inngest** | Event-driven, hosted, good developer experience, step-level durability and retries as first-class primitives, fast to adopt. | Vendor-hosted control plane; less suited to very long-lived, high-fan-out workflows than Temporal. |

**Recommendation (revised from this RFC's first draft):** build Layer 1 against a small internal interface (`step.code`, `step.agent`, `step.gate`, `fanout`, `await gate(...)`) with a **Firestore-backed implementation shipped first** — this was Postgres in the original draft of this section; Firestore is the better Phase-1 choice specifically because your stack already runs on it exclusively and stands up nothing new — and treat **Temporal as the production target** once the pilot agent (RFC-02 §3) proves the three-layer shape is right. Because the interface is small and workflow code never talks to Firestore or Temporal directly, this swap is an adapter change, not a rewrite — the same principle used for the tool layer's lab/prod adapters in §9.

Do not put durability logic inside `BaseAgent` itself. Reasoning and orchestration are deliberately separable, and mixing them was a real source of bugs in the system this replaces.

### 8.4a Firestore adapter — concrete shape for Phase 1

- **Collections:** `agentEngineRuns/{runId}` (run-level document: `clientSlug`, `productId`, `runKind`, `cadenceDate`, `status`, `budget`, `createdAt`), `agentEngineRuns/{runId}/steps/{stepId}` (one doc per completed/in-flight step: the `AgentStepTelemetry` shape from §5.1, written with `set(..., {merge: true})` before the next step starts — this is the checkpoint), `agentEngineRuns/{runId}/slots/{slotId}` for fan-out state, `agentEngineGates/{gateId}` for the typed gate contract in §8.3.
- **Idempotency:** the document ID *is* the idempotency key (`runId`/`stepId`/`slotId` combination) — a retried write is just the same `set(..., {merge:true})` again, satisfying §9.1 rule 2 with no extra plumbing.
- **Resume:** on restart, read `agentEngineRuns/{runId}` and its `steps` subcollection, find the highest completed step index, and continue — the Firestore equivalent of "engine-level resume by construction," replacing "list the folder and find the lowest missing number" with a single indexed query.
- **Access pattern:** goes through the same Admin-SDK-only, server-side pattern the rest of `karosCMO` already uses (`src/lib/data.ts`) — `agent-engine` should follow that convention directly (a small `agent-engine/packages/workflow/adapters/firestore/` module playing the same role `data.ts` plays for the portal), rather than inventing a different access style.
- **Cancellation / one-writer-per-row locks:** reuse the Redis instance `agent-service` already runs (`agent-service/src/state/jobs-store.ts` is the existing example — a CAS-via-Lua-script pattern over `ioredis`) for the small amount of fast, ephemeral coordination a fan-out needs (e.g. "only one workflow may currently be writing this product's dashboard snapshot"). Firestore stays the durable system of record; Redis is coordination only, exactly the role it already plays today.

### 8.5 Migrating from Firestore to Postgres, later — what triggers it and how

This is intentionally not a Phase 1 task. Document it now so that when the trigger condition is hit, the path is already known rather than improvised.

**When to actually do this:**

1. You adopt **Temporal** as the orchestration engine (§8.4's stated target). Self-hosted Temporal needs its own persistence layer, and Postgres is Temporal's best-supported option — at that point you're standing up Postgres *for Temporal's server*, not to replace Firestore as your application's data store. `agentEngineRuns`/`steps`/`slots` can stay in Firestore as your own queryable record even after Temporal owns workflow execution state, or you can migrate them alongside if you want one store.
2. Independently of Temporal, if the **evals harness or cost-reporting queries** (RFC-01 §12) start needing relational joins/aggregations across thousands of historical runs that Firestore's document-query model handles awkwardly — that's a sign to introduce Postgres as an analytical/reporting store fed from Firestore, before considering it as the live system of record.

**How to do it, when the time comes:**

1. **Provision Cloud SQL for PostgreSQL** on the same GCP project the rest of the stack runs on (`gcloud sql instances create`, or via your existing Terraform/deploy tooling if `karosCMO`'s `cloudbuild.yaml`/`deploy/` already has an IaC pattern to extend — check there first rather than hand-rolling). Use the **Cloud SQL Auth Proxy** (or a private-IP connection from Cloud Run, matching how `agent-service` already reaches its other GCP dependencies) rather than a public IP.
2. **Add the connection as new env vars**, following the existing convention in `agent-service/.env.example`/`.env.example` (which already documents required vars per dependency, e.g. `REDIS_URL`, `AGENT_ARTIFACTS_BUCKET`): add `DATABASE_URL` (or `POSTGRES_HOST`/`POSTGRES_DB`/`POSTGRES_USER`/`POSTGRES_PASSWORD` if you prefer discrete vars matching the existing style), and a `PGSSL`/connection-pool-size setting if needed.
3. **Generate the schema from the same Zod types already in `agent-engine/packages/core`** — `AgentStepTelemetry`, the run/slot record shapes, the `Gate` interface from §8.3 — using a typed query builder (Kysely or Drizzle both fit a Zod-first codebase well) rather than hand-writing SQL DDL. A `db:migrate` script run once against the fresh Cloud SQL instance creates `runs`, `slots`, `steps`, and `gates` tables directly from those type definitions, so the tables are provably in sync with the code that writes to them.
4. **Backfill, don't cut over blind:** write a one-time script that reads every `agentEngineRuns/*` document (and subcollections) via the Admin SDK and inserts the equivalent Postgres rows, then compare row counts and spot-check a sample before switching the adapter.
5. **Swap the adapter, not the workflow code.** Because Layer 1's interface (`step.code`/`step.agent`/`step.gate`/`fanout`) never talks to Firestore directly (§4's invariant), this is: implement `agent-engine/packages/workflow/adapters/postgres/`, point config at it, done. No workflow definitions change.

Flag this section back to Claude Code explicitly when the trigger condition is actually met — don't let this become "we should probably do this someday" background noise; treat it as a scoped, small project with a clear starting point (steps 1–5 above), the same way this RFC treats the Firestore→Temporal question in §8.4.

---

## 9. Tool Registry & MCP servers (Layer 3)

### 9.1 Design rules (apply to every tool, no exceptions)

1. **Tenant comes from the run context, never from a model-supplied argument.** No tool takes a `client_id`/`client_slug` parameter that the model fills in — it's bound from `AgentContext` before the call reaches the model. This turns "a model could theoretically write to the wrong client" from a documented risk into a structurally unrepresentable one.
2. **Every write is idempotent on a caller-supplied key** (typically `(run_id, slot_id, kind)`). Replay becomes free.
3. **Errors are typed and actionable** — `tooling_error` distinct from `content_fail` distinct from `not_available`, everywhere, always.
4. **Return the smallest useful shape.** Summaries with handles for detail, not full payloads — tool results should not dominate the agent's context window.
5. **Version the tool, not the prose.** `toolVersion` travels into every ledger row and every telemetry record, so a behavior change is attributable.
6. **The schema is the documentation.** Generate connector/tool reference docs from the Zod/tool registry, never hand-maintain both — this is the single highest-leverage fix against documentation drift.

### 9.2 Server catalogue (draft — refine per real connector inventory during Phase 1)

| Server | Responsibility | Representative tools |
|---|---|---|
| `karos-client` | Read-only, tenant-bound client data | `client.getProfile`, `client.getBrand`, `client.getVoiceRules`, `client.listCompetitors`, `client.getExecutives`, `client.getConfig` |
| `karos-research` | Egress-bound, cached, freshness-enforced external data | `research.pull(job, query, window)`, `research.getRuns`, `research.writeRun`, `research.checkFreshness` |
| `karos-topics` | The no-repeat / topic-catalog contract, as code | `topics.reserve`, `topics.commit`, `topics.release`, `topics.topUp` |
| `karos-gates` | Deterministic validators with typed verdicts | `gate.lintPost`, `gate.noPlaceholder`, `gate.brandCompliance`, `gate.leakCheck`, `gate.numbersSourced` |
| `karos-ledger` | The one place all deliverables/events/briefs are written | `ledger.writeDeliverable`, `ledger.appendEvent`, `ledger.upsertBrief`, `ledger.dashboardSnapshot`, `ledger.feedbackAppend` |
| `karos-memory` | Structured, retrieved (not loaded-whole) instance memory | `memory.read(scope)`, `memory.appendDecision`, `memory.appendHypothesis`, `memory.resolveHypothesis`, `memory.updateBeliefs(diff)` |
| `karos-publish` | Capability-scoped, draft-first publishing | `publish.draft`, `publish.schedule`, `publish.status` |

Each server ships with **two backends, selected by config, not by code path**: a **file + git adapter** for local/lab development (mirrors today's filesystem-as-state approach, so nothing about local iteration gets harder), and a **platform API adapter** for production. This dual-adapter design is what makes the eventual GCP/platform export a configuration change instead of a rewrite.

### 9.2.1 Registered-but-unwired tools — SCRUM-295 / AU10 audit (2026-08-28)

A grep across `agents/`, `apps/`, and `evals/` (excluding tests) found 11
tools in the always-on registry — every tool `createAllKarosTools()` (§13,
`packages/tools/src/index.ts`) merges into every agent's `AgentToolRegistry`
regardless of whether that agent's workflow calls it — with **zero
production call sites**: `ledger.upsertBrief`, `memory.appendHypothesis`,
`memory.resolveHypothesis`, `publish.draft`, `publish.schedule`,
`publish.status`, `research.getRuns`, `research.writeRun`,
`research.checkFreshness`, `video.assetsCheck`, plus test-only
`intel.getReport`. That is roughly 20% of this catalogue's implemented
surface, and every one of them still costs registry tokens in every agent's
tool list on every turn — the reason this audit sits next to AU7's registry
cost work. All 11 are implemented and spec-complete (they appear in §9.2
above); none is accidental scaffolding. Each gets a recorded disposition
below instead of a silent delete, so this table stops being able to drift
from what's actually wired without someone having to say so:

| Tool(s) | Disposition |
|---|---|
| `video.assetsCheck` | **Wired, this change.** `create-branded-shorts-agent-workflow.ts` step `00a-assets-check` now calls it on every Branded Shorts run, right after the client's `brandedShortsProfilePath` is resolved and before that profile is read or anything downstream touches it — the guard the 0-byte-font incident (§4 above / RFC-06 §4) needed and, until this change, never had anywhere in the codebase. |
| `publish.draft`, `publish.schedule`, `publish.status` | **Pending, not dead.** Tomer's decision record (SCRUM-333, decision 16, 2026-08-28): real publishing **is** being built — a global auto-publish toggle plus per-post manual control, executing only for channels where the client has completed a full platform integration. These three tools are already the draft/schedule/status record-keeping layer that decision needs (idempotent JSON records, keyed on `draftId`); they stay in the registry as the layer the publish feature builds on, not as abandoned surface. What is genuinely still missing — the per-platform publish adapters (X/LinkedIn/Instagram/Reddit) and the toggle/gating logic itself — does not exist in this repo yet and is not part of this change; nothing here posts anywhere. `packages/tools/karos-publish/README.md` updated to match. |
| `ledger.upsertBrief` | **Unwired, kept.** Idempotent brief storage, spec-complete; no workflow writes a brief yet. Kept as ready-but-unused rather than removed, since deleting a spec-complete write path only to re-add it the next time an agent needs one is a worse outcome than the token cost of carrying it. |
| `memory.appendHypothesis`, `memory.resolveHypothesis` | **Unwired, kept.** The open/resolve pair for `karos-memory`'s hypothesis tracking (§9.1); no agent currently runs a hypothesis/experiment loop that would call them. Same reasoning as `ledger.upsertBrief`. |
| `research.getRuns`, `research.writeRun`, `research.checkFreshness` | **Unwired, kept.** `research.pull` — the one `karos-research` tool actually on a call path — already reads and writes its own run log directly against `runs.ts` (`latestRunForQuery`/`runSegments`), not through these three tool wrappers. They remain the externally-callable surface for a workflow that wants run history or a staleness check without calling `research.pull` itself; none does yet. |
| `intel.getReport` | **Unwired in production, kept.** The read side of `intel.writeReport`, which *is* wired into production (SCRUM-267's portal-facing `clientReports` store). Six agent workflows (`x-agent`, `linkedin-agent`, `instagram-agent`, `reddit-agent`, `blog-agent`, `newsletter-agent`) already carry a comment noting `intel.getReport` has been registered since the intel agent shipped with no channel-agent caller — content agents read the intel report via `readClientIntelContext`, a different path, not this tool. It stays registered for the portal's own read path and for tests verifying `intel.writeReport`'s effect. |

**Why reconcile instead of delete.** A registry entry with no caller is a
real, measurable cost (tokens on every turn), but three of the six rows
above are load-bearing for a decision or a read path that already exists
elsewhere in this repo, and none of the eleven is accidental. Deleting a
spec-complete tool and re-adding it the next time a workflow needs it is a
worse outcome, repo-wide, than this table telling the truth about which
tools are wired and which are staged. This section is the reconciliation;
it should be re-read (and re-written) the next time one of these tools
either gains a caller or is deliberately removed.

### 9.3 Serving

All servers are served over MCP (HTTP, 2026-07-28 spec) as one deployment, with tenant resolved from a scoped credential at the edge (header-based routing, per §9.4). Local Claude Code sessions and the Agent SDK runner both connect to the same tool definitions — no drift between "what the lab sees" and "what production sees."

---

## 10. Multi-tenancy and security

- **Run-scoped credentials.** The workflow mints a short-lived credential bundle for exactly one `client_slug` + `product_id`. Tools resolve tenant from it — never from a model argument (§9.1 rule 1).
- **Write-fence as a hook, not a rule someone has to remember.** A `PreToolUse` hook runs *before* permission evaluation and can block outright: reject any write outside the bound client's scope, reject any path traversal (`..`), reject any attempt to write into shared/product-template space from a client-scoped run.
- **Egress allowlist derived from the manifest**, not maintained by hand in two places — generate the container's network allowlist from the same declarative source that defines each step's tools.
- **Cross-tenant/aggregate output gets a different tool set entirely.** A cross-client workflow (e.g. a "Chief Social Officer"-style aggregation) is issued read-only aggregate tools and literally cannot call `ledger.*` — this turns a policy into a wiring fact.
- **Skill/policy edits stay append-only and human-authored**, enforced by the policy store rather than by diff inspection.

---

## 11. Observability, cost telemetry, and budget

- **One OpenTelemetry span per workflow step and per tool call**, tagged with `run_id`, `client_slug`, `product_id`, `slot_id`, `tool_version`, tokens (cached/uncached split), and cost in USD. The Agent SDK surfaces per-turn usage natively; hooks are the instrumentation point for everything else.
- **Per-step, not just per-run, cost attribution.** This is what turns "should we move this step to a cheaper model" from a judgment call into a number.
- **Budget enforced before spend, not audited after.** A per-run token/dollar ceiling, checked before each agent step starts (§8.1), replaces the asserted-but-unenforced monthly cap pattern.
- **Feed the portal real events.** Once the work behind a run is genuinely typed tool calls (not prose-plus-bash), the portal's existing transcript viewer becomes informative with no UI rewrite — it was already built to render `tool_use`/`tool_result` blocks; it just hasn't had real ones to show.
- **GCP note:** checkpoints and step telemetry land in Firestore per §8.4a — no separate decision needed here, since it's the same store as the workflow layer's durability records. Span export (OpenTelemetry) can go to Cloud Trace/Cloud Monitoring directly, matching the rest of the GCP-hosted stack.

---

## 12. Evaluation & benchmark framework

You cannot claim an agent is "best in class" without a way to measure it, and you cannot safely let agents self-modify their own policy (an explicit longer-term goal) without this existing first. Build, in increasing order of value:

1. **Golden runs.** For each agent, a frozen input bundle plus an endorsed output, produced by a human sign-off *before* the first automated run — so a pilot produces a verdict, not an impression.
2. **Deterministic assertions.** Every gate tool runs against the golden output. Fast, free, catches regressions (format violations, banned words, missing source references, broken JSON) with zero model cost.
3. **Rubric judging (LLM-as-judge).** A strong judge model scores craft-quality dimensions on a fixed sample — brand voice fidelity, hook strength, platform-convention adherence — on a 1–5 scale, derived from the same rules that live in the skill body.
4. **Policy-change gate.** Before a manager-agent-proposed policy change (or a model/prompt change on any step) ships, it runs against the eval set and must clear both a quality threshold and a cost-delta threshold (recommend: no quality regression, cost increase capped at 15%) before a human even sees it for approval.
5. **Production sampling.** Score a small percentage of live runs on the same rubric continuously, and alert on drift.

This is also the honest way to answer "should we move this step to a cheaper model": change the model on that step, run the evals, read the score and the dollar delta, decide — instead of a judgment call with no baseline.

---

## 13. Proposed repository layout

```
agent-engine/
  packages/
    core/                    # BaseAgent, AgentContext, ModelRouter, telemetry types
    workflow/                # Layer 1: step.code/step.agent/step.gate, fanout, gate() primitive
                              #   adapters/firestore/ (Phase 1)  adapters/postgres/ (later, §8.5)  adapters/temporal/ (target, §8.4)
    tools/                   # Layer 3: one folder per MCP server
      karos-client/
      karos-research/
      karos-topics/
      karos-gates/
      karos-ledger/
      karos-memory/
      karos-publish/
      adapters/file-git/     # lab backend
      adapters/platform/     # prod backend (GCP)
    telemetry/                # OpenTelemetry setup, cost calculators, span helpers
  agents/                     # RFC-02 territory: one folder per concrete agent
    x-agent/
    linkedin-agent/
    ...
  evals/
    golden-runs/
    judges/
    ci-gate/
  docs/
    RFC-01-agent-engine-core.md   # this document, versioned
    RFC-02-agent-migration.md
  infra/
    docker/
    ci/
```

---

## 14. Definition of done — Phase 1 (this RFC)

Phase 1 is complete when:

- `BaseAgent` exists with the interfaces in §5, runs the ReAct loop with a real `maxSteps` guard, and enforces `allowedTools` narrowing.
- All seven Layer 3 MCP servers exist with the file+git (lab) adapter, unit-tested per §9.1's rules, including freshness windows, fallback chains, the topic floor, and dedupe rejection.
- The `ModelRouter` exists with adapters for at least Anthropic-direct and one commodity-tier provider, wired to the three-tier policy in §5.4.
- The Postgres-backed workflow interface (`step.code`/`step.agent`/`step.gate`/`fanout`/`gate()`) exists and can express the illustrative workflow in §8.2.
- OpenTelemetry spans emit the four measurements from §11 for every step, on every run.
- One real, end-to-end pilot run (any agent, ideally the one selected in RFC-02 §3) executes through all three layers and produces a `DynamicAgentRunReport`-shaped event stream the portal can render.
- The evals harness exists with at least one golden run and passes it deterministically.

## 15. Open decisions for you

1. **Repo strategy** — separate repo (recommended, §1.1) vs. a package inside an existing monorepo.
2. **Orchestration engine** — start on Firestore and target Temporal (recommended, revised in §8.4/§8.4a), or commit to Temporal from day one.
3. **When to introduce Postgres** — deferred by default until one of §8.5's trigger conditions is actually hit (Temporal adoption, or evals/reporting queries outgrowing Firestore) — not a Phase 1 decision, but confirm you're comfortable deferring it rather than wanting it sooner for other reasons.
4. **Vertex AI timing** — wire up at production cutover (recommended, §5.4/§11) vs. earlier if operational redundancy risk is already biting.
5. **Whether the portal's "custom agent" and "dynamic agent" systems should eventually merge onto this engine's step model** (§7.5) — a real product-roadmap decision with its own cost, flagged as a recommendation, not assumed.
6. **Gateway for portable/commodity tiers** — self-hosted LiteLLM (recommended, cheapest, most control) vs. a hosted option (OpenRouter/Portkey) if you'd rather not operate it yourselves.
7. **Whether `agent-engine` should become the literal successor to `agent-service/runner/src/dynamic/step-runner.ts`** for Dynamic Agent Studio runs specifically (§7.2) — this session did not read that runner's internals directly, so confirm with Shlomi that a drop-in replacement is as clean as §7 assumes before committing to it as the first integration proof point.

---

## 16. Findings from a direct read of the real `karos-agents` and `karosCMO` repos (verified this session)

Everything below was read directly (not inferred) from the connected `karos-agents` and `karosCMO` folders, specifically while investigating the X agent (the RFC-02 pilot). Each finding changes something concrete in this RFC or is urgent enough to act on independently of it.

### 16.1 System prompts already live in git as raw string literals — confirmed, not assumed

`karosCMO/scripts/register-x-agent-v2.ts` registers X Agent v2 as a `customAgents` Firestore document. Its entire system prompt — several hundred words of operational instructions — is a plain JavaScript template literal (`const INSTRUCTIONS = \`...\``) committed directly in that script, then copied verbatim into a Firestore document field (`instructions`) when the script runs. This is the exact anti-pattern you flagged: the prompt's source of truth is a script file mixed in with deployment code, not a managed, versioned, independently-editable store, and — as §16.2 below shows — it has already drifted from the "official" skill doc it's supposedly wrapping.

**Recommendation:** move craft-policy/system-prompt content (RFC-01 §1.3, §5.2 `skillRef`) into its own versioned store, referenced by ID from `BaseAgent` step configs, rather than embedded in either a skill's Markdown body *or* a deployment script. Two real options, not a foregone conclusion:

- **A Firestore-backed prompt store** (a `promptVersions` collection: `{promptId, version, content, updatedBy, updatedAt, status}`), consistent with everything else in the stack and requiring no new vendor integration. `BaseAgent`'s `skillRef` resolves to `promptId@version` instead of a file path.
- **Vertex AI's prompt management surface** (Vertex AI Studio's prompt gallery / prompt versioning, which Google has been actively building out) — worth evaluating specifically if you want prompt experiments and evals tied directly into Vertex's own tooling. Flagged as worth a spike, not a default, since this session did not verify its exact current API maturity against your other requirements (multi-tenant scoping, append-only edit history per RFC-01 §10) — re-check before committing.

Either way: **git keeps the code that reads the prompt store; it stops holding the prompt content itself.** This is a bigger change than it sounds, because it also fixes §16.2.

### 16.2 A live, concrete example of prompt/doc drift — the X agent's actual behavior already diverged from its own committed skill

`products/building/x-agent-v2/SKILL.md`, `references/run-protocol.md`, and `references/lanes.md` (committed, read directly) describe a **batched run**: one run drafts N posts (5/10/21) across six lanes, with slot ids `p01`–`p10`. But `register-x-agent-v2.ts`'s `INSTRUCTIONS` field — the thing actually running in production — contains an explicit, dated override: *"One run produces exactly one post. This is the product ruling of 2026-08-11 and it supersedes the skill's own batch framing wherever the two disagree."*

This is not a hypothetical drift risk — it is a **present-tense fact about the agent you're about to migrate first**: the git-committed skill and the deployed behavior already disagree, and the only reason anyone knows which one is current is that someone wrote it into a Firestore-bound instructions string. This is exactly the failure mode §16.1 fixes, and it means **RFC-02's X-agent migration (§3) must be built against the one-post-per-run behavior actually running today, not the batch framing in the committed skill files** — see the corrected worked example below.

### 16.3 Secrets are currently leaking into Cloud Run audit logs — act on this regardless of `agent-engine`

Also found while reading the X agent's operational history (`scripts/cowork-handoff-x-agent-fix.md`, a real incident handoff dated this month): `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY`, `XAI_API_KEY`, and `APIFY_TOKEN` are currently visible in plaintext in `karoscmo-prep`'s Cloud Run Job `RunJob` audit logs, because `agent-service/src/queue/worker.ts`'s `buildRunnerEnv` injects them as per-execution `--update-env-vars` rather than mounted `--set-secrets` from Secret Manager. This is a live exposure, not a design discussion — **recommend rotating those three keys in Secret Manager independently of anything in this RFC**, and treating it as urgent regardless of the `agent-engine` timeline.

For `agent-engine` itself: **rule — no credential is ever passed to a container as a literal environment variable value.** Every secret (Anthropic/model API keys, connector tokens) is mounted from Secret Manager at container start. Add this explicitly to §10's write-fence/credential-scoping rules; it was implicit before, it should not be implicit anymore given a real instance of the alternative already happened.

### 16.4 An idle-connection bug worth avoiding by design in the new runner

The same incident (§16.3's source doc) root-caused a separate, now-fixed bug: the agent-runner container made infrequent callbacks (minutes apart) to its own internal API; Cloud Run's load balancer silently closed the idle backend connection in the gap, and Node's default `fetch` reused the dead socket, failing as an opaque `TypeError: fetch failed` — which then surfaced as the generic, unhelpful `"job container exited without reporting"` because the error's `cause` wasn't logged. Fixed via a dedicated `undici.Agent` with `keepAliveTimeout: 1` (effectively disabling connection reuse) for these specific infrequent calls.

**For `agent-engine`:** any internal service-to-service call made infrequently within a long-running step (a workflow worker pinging back a status, a step reporting progress) should either use a fresh connection per call or an explicitly short keep-alive, not a default pooled HTTP client — and always log `err.cause`, not just `err.stack`, so a network-layer failure is distinguishable from an application error at the point it's logged, not just at the point it's typed (RFC-01 §6's `tooling_error` category exists precisely to prevent this exact class of bug from being misreported as a content failure).

### 16.5 The X agent already straddles both portal agent-definition systems — this sharpens §7.5, it doesn't just inform it

`register-x-agent-v2.ts` registers X v2 as a `customAgents` document (`enabled: false`, `source.status: "unreviewed"`) — the older, hardcoded agent-definition system (RFC-01 §7.5). But the incident handoff in §16.3 references a **live `dynamicAgentSpecId`** (`huMsrTKukcdqjz5sU7cX`) for "X Agent" runs on the `prep` Firestore database — the newer Dynamic Agent Studio system (RFC-01 §7.1–§7.3). **Both exist right now, for the same agent, and this session could not determine from the files read which one is actually authoritative for current X traffic.** Don't guess: confirm with Shlomi which of these two is live before RFC-02's X-agent migration starts, since it changes which contract `agent-engine` needs to satisfy at cutover (the `DynamicAgentRunReport` shape per §7, or the older custom-agent job shape, or — plausibly — both, if traffic is currently split).

### 16.6 Firestore's prep/production split is already a real, working pattern — reuse it

`karosCMO` already runs two Firestore databases in one GCP project (`(default)` for production, a named `prep` database for the pre-production environment), with `karoscmo-prep` auto-deploying on push to `main` and production promoted only via a manual, approval-gated GitHub Actions workflow (`promote-production.yml`). This directly validates and extends RFC-01 §8.4a: `agent-engine`'s Firestore-backed workflow store should adopt the same `prep`/`(default)` database split already operating today, rather than inventing a different environment-separation convention.

---

*Hand this document to Claude Code together with RFC-02 (Agent Migration Playbook). Recommended framing for the first implementation session: "Build Phase 1 of RFC-01 — start with the tool registry (§9) and `BaseAgent` (§5), since the tool layer pays off even before the workflow layer exists." Read §16 first if this is a fresh session — it contains findings from the real codebase that override some of the illustrative assumptions earlier in this document.*
