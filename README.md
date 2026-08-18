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

## Running it

Requires Node >= 22 (`.nvmrc` pins 22; the `engines` field enforces the floor).

```bash
npm install
npm run build     # every workspace, in dependency order — see the note below
npm run verify    # workspace-wide typecheck + every package's own test suite
```

`npm run build` is an explicit, ordered chain rather than
`npm run build --workspaces`, which does **not** guarantee topological order.
Each package compiles to `dist/` and its dependents resolve that `dist/`
through the workspace symlink, so a package built before its dependencies
fails with `TS2307: Cannot find module`. **`apps/agent-server/Dockerfile`
hardcodes the same order in its own `RUN` step — a new package has to be added
to both.**

### Checking it without an API key

The fastest real verification. Every tool call, gate verdict, and checkpoint
is genuine; only the model is scripted, so these need no key, no GCP, and no
network:

```bash
npm run demo:e2e      # all three layers in one run, incl. a human gate + resume from checkpoint
npm run smoke         # the full agent-server HTTP surface, in-process
```

`npm run demo:agents` (`scripts/demo-agents-run.ts`) currently **fails** — it
has drifted from the workflows it demos: it hardcodes a 16-step list and reads
`09-draft-post`, but the X agent is now 21 steps with the draft at
`10-draft-post`, and both agents gained a `15-batch-review` human gate the
script never resolves (pass `autoApprove: true` to the workflow factory, or
resolve the gate, to get a `completed` run).

### Running the HTTP server locally

```bash
cp .env.example .env       # then put a real ANTHROPIC_API_KEY in it
npm run setup:local        # builds .local/prompts + seeds a demo tenant
npm run dev:server         # tsx watch, or `npm run start:server` for the built output
```

Both server scripts read `.env` through Node's own `--env-file` flag. Nothing
else in the repo loads `.env` implicitly — there is no `dotenv` dependency —
so any other command needs its variables exported the usual way.

`npm run setup:local` exists because two things have no working default:

- **Prompts.** `FilePromptStore` resolves `<root>/<promptId>/<version>.md` from
  one root, but prompts ship per agent (`agents/x-agent/prompts/x-craft/1.md`).
  The script merges them all into `.local/prompts`. Without it,
  `PROMPT_STORE_DRIVER=file` has nothing valid to point at, and the `memory`
  default starts empty — every `skillRef` resolution then fails.
- **Client state.** Each workflow reads its entire input from persisted client
  state, so a run against an empty workspace stops at `00-intake-check` with
  status `blocked_intake`. The script seeds one tenant (`acme`) matching the
  fixture in `apps/agent-server/__tests__/test-helpers.ts`.

Then:

```bash
curl localhost:8080/healthz
curl -X POST localhost:8080/api/v1/runs/start -H "Content-Type: application/json" \
  -d '{"clientSlug":"acme","productId":"linkedin-agent","runKind":"recurring"}'
```

Every `/runs/start` makes real, billable Anthropic calls. Valid `productId`s
are the six in `KNOWN_PRODUCT_IDS` (`apps/agent-server/src/wiring/workflows.ts`)
— note that `instagram-agent`, `seo-geo-agent`, and `intel-report-agent` are
built and tested but not yet dispatchable through the server.

## Status of the source specs

Both RFCs were produced from a direct read of the live `karosCMO` repository
(types, the Dynamic Agent Studio contracts, `agent-service`'s state layer) as
of August 2026. Re-verify anything version-specific (model names, package
versions, exact field names) against the current `karosCMO` state before
relying on it — the codebase moves faster than this document.
