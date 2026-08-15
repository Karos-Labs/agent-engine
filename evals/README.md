# evals/

Golden runs, deterministic gate assertions, and the LLM-as-judge harness —
see `docs/RFC-01-agent-engine-core.md` section 12.

Subfolders to add as the first agent gets its eval suite:
- `golden-runs/` — frozen input bundles + human-endorsed outputs, one per agent
- `judges/` — rubric-judge prompts and scoring logic
- `ci-gate/` — the regression gate run before any model/prompt/tool change ships
