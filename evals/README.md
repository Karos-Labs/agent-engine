# evals/

Golden runs, deterministic gate assertions, and the LLM-as-judge harness —
see `docs/RFC-01-agent-engine-core.md` section 12.

Layout:
- `golden-runs/` — frozen input bundles + human-endorsed outputs. Each agent
  also keeps its own under `agents/<agent>/evals/golden-runs/`, loaded through
  this package's `loadGoldenRunFixture`.
- `src/judge/` — the rubric, the judge prompt, and `runRubricJudge` (rung 3).
  Takes a `ModelRouter`, so it is stubbed in CI exactly as every agent stubs a
  model call.
- `src/language.ts` — per-language grading (rung 4). English and Hebrew today.
- `src/scoring/` — deterministic checks + language + rubric, combined into one
  `EvalScore`.
- `src/persistence/` — that score as one `bi_telemetry.agent_runs_bi` row
  (rung 5), with a BigQuery-backed sink and a strict in-memory one for CI.
- `src/production-sampling.ts` — approved-vs-revised production drafts as an
  ongoing signal, scored on the same rubric (rung 6).

Not built yet: `ci-gate/` — RFC-01 §12 bullet 4's policy-change gate (no quality
regression, cost increase capped) that runs this suite before a model/prompt
change ships.
