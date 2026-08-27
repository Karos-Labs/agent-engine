# Production verification run — harvest plan

Written BEFORE dispatch. One run, many verifications.

## Brief

`instagram-agent` for `karoslabs`, `runKind: recurring`, dispatched via **Pub/Sub**
(`karos-agent-runs-prod`) — never `/runs/start`, because AU66's 300s CPU cliff is
live in prod and that route holds the request open across it.

`karoslabs` is our own client, so a draft that reaches the human gate affects no
external client. The workflow pauses at that gate and never publishes.

Chosen over the cheaper `linkedin-agent` for one reason: prod has **no**
`UNSPLASH_ACCESS_KEY` / `PEXELS_API_KEY` / `PIXABAY_API_KEY` / `GOOGLE_PLACES_KEY`
(confirmed in the prod capability report). So the media path is guaranteed to
produce a **non-success tool outcome** — which is the only way to demonstrate
AU67 in prod. A run where everything succeeds cannot distinguish AU67's new
status vocabulary from the old behaviour.

## What each observation is for

| Ticket | Observation to harvest |
|---|---|
| SCRUM-360 [AU61] | `jsonPayload.event="model.failover"` in `karoscmo` during the run window — count, from/to, errorClass |
| SCRUM-361 [AU62] | Vertex publisher metrics for the window vs our own telemetry: confirm Claude is invisible to GCP but visible to us |
| SCRUM-365 [AU67] | Step records where `status` is `content_fail` / `not_available` / `tooling_error` rather than `completed` — the vocabulary only reachable via a real tool failure |
| SCRUM-355 [AU56] | The media step's recorded outcome and reason, showing the absent-key degradation as a first-class result |
| SCRUM-356 [AU57] | Not runtime — build-time. Excluded deliberately; no run can verify it |
| Telemetry columns | `agent_runs_bi` rows for this runId carrying `operation` / `jobId` / `stepId` / `source` — the four that were silently dropped for months |
| Cost | `totalCostUsd` from the run record + the BigQuery sum, reported as measured, never estimated |

## Stop conditions

The run pauses at its human gate or halts on the media outcome. Neither
publishes. If it reaches a Chromium render it runs on the worker, which has
`cpu-throttling=false` and `min-instances=1`, so the AU66 cliff does not apply.
