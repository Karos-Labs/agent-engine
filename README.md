# agent-engine

Karos Labs' autonomous agent runtime. Replaces the prompt-chaining pattern in
`agent-service` with a real three-layer architecture:

1. **Orchestration (code)** — a durable workflow per run: identity, checkpoints,
   retries, budget, human gates.
2. **Agent steps (`BaseAgent`)** — a bounded ReAct loop with narrow tools and a
   typed output schema. Every concrete agent (`XAgent`, `LinkedInAgent`, ...)
   inherits from this.
3. **Tools (MCP)** — every external read/write is a typed, tested, versioned
   tool server.

**Start here:** [`docs/RFC-01-agent-engine-core.md`](docs/RFC-01-agent-engine-core.md)
defines the engine itself (this is the spec to build against first).
[`docs/RFC-02-agent-migration.md`](docs/RFC-02-agent-migration.md) is the
playbook for migrating each existing skill onto this engine — read it only
once RFC-01's tool layer and `BaseAgent` exist.

## Relationship to other repos

- **`karosCMO`** (sibling folder) — the portal and the legacy `agent-service`
  runner. `agent-engine` is developed alongside it, not inside it. During
  early development, keep this repo's parent directory open in your editor/
  Claude Code session so you can read `karosCMO`'s real contracts
  (`src/lib/types.ts`, `src/lib/data.ts`, the `dynamic-agent-*` files) as
  ground truth while building the tool layer — see RFC-01 §9 and §7.
- **`karos-agents`** (separate repo, not yet connected here) — the skill
  library. Skills stay Markdown; they become the craft-policy layer loaded by
  `BaseAgent` steps, per RFC-01 §1.3.

## Repo layout

```
packages/core/          BaseAgent, AgentContext, ModelRouter, telemetry types      (RFC-01 §5)
packages/workflow/       Layer 1 primitives: step.code / step.agent / step.gate /
                         fanout / gate() — Firestore adapter first, Postgres and
                         Temporal adapters later                                    (RFC-01 §8)
packages/telemetry/      OpenTelemetry setup, cost calculators                       (RFC-01 §11)
packages/tools/*         One folder per MCP server (karos-client, karos-research,
                         karos-topics, karos-gates, karos-ledger, karos-memory,
                         karos-publish)                                              (RFC-01 §9)
agents/                  One folder per concrete agent (XAgent, LinkedInAgent, ...)  (RFC-02)
evals/                   Golden runs, judges, CI regression gate                     (RFC-01 §12)
infra/                   Docker, CI
```

## Status

Scaffold only — no implementation yet. Nothing in this repo has been built or
tested. The recommended first task for a coding session:

> Read `docs/RFC-01-agent-engine-core.md` in full. Build only
> `packages/tools/karos-gates` end to end: Zod schemas, the file+git lab
> adapter, and unit tests, following the design rules in RFC-01 §9.1. Don't
> start anything else yet.

## Status of the source specs

Both RFCs were produced from a direct read of the live `karosCMO` repository
(types, the Dynamic Agent Studio contracts, `agent-service`'s state layer) as
of August 2026. Re-verify anything version-specific (model names, package
versions, exact field names) against the current `karosCMO` state before
relying on it — the codebase moves faster than this document.
