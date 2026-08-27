# Production verification run #2 — harvest plan

Written BEFORE dispatch. Follows run #1, which verified AU61/AU62/per-unit cost
but produced ZERO BigQuery rows — the finding that became AU72/SCRUM-372.

## Brief

`linkedin-agent` for `karoslabs`, `runKind: recurring`, via **Pub/Sub**
(`karos-agent-runs-prod`).

Deliberately smaller than run #1's `instagram-agent`. Run #1 already verified
the expensive paths (per-unit image cost, Chromium render on the worker), and
repeating them buys nothing. What is unverified is whether telemetry now
LANDS — and that needs model calls, not images. linkedin is the cheapest
product that makes real agent-step model calls.

Runs against the code already deployed to prod (`c913408`), which does NOT
carry this round's loudness fix. That is the point: the grant alone must be
sufficient. If rows appear, the diagnosis was right and complete.

## What each observation is for

| Ticket | Observation |
|---|---|
| SCRUM-372 [AU72] | `SELECT` rows from `karoscmo.bi_telemetry.agent_runs_bi` for this runId, with `operation` / `jobId` / `stepId` / `source` populated — the four columns silently dropped for months, on a sink that had never written at all |
| SCRUM-360 [AU61] | `model.failover` count for this run's window, in prod |
| SCRUM-361 [AU62] | Vertex publisher metrics for the window vs our own rows — the asymmetry, now measurable from both sides for the first time |
| SCRUM-365 [AU67] | Any step recording `content_fail` / `not_available` / `tooling_error`. Run #1 produced none because everything succeeded; recorded here as expected-to-be-empty rather than pretended |
| Cost | `totalCostUsd` from the run record, cross-checked against the BigQuery sum — the first time both sources exist in prod |

## Stop condition

Pauses at its human review gate. Never publishes.
