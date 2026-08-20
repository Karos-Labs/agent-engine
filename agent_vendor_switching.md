# agent-engine: any step, any model vendor

**Date:** 2026-08-20 · **Repo:** `karoslabs/agent-engine` · **Status:** implemented, fully verified offline (build+typecheck+test+demo+smoke), no live non-Anthropic credential check yet.

Builds directly on `claude/agent-engine-agent-platform-route.md` (the same day's earlier task, which put Claude's own traffic through Google Cloud's Agent Platform). This task generalizes the router so **every one of the 25 model-selection points in the codebase can independently use any vendor Agent Platform serves** — Claude, Google's own Gemini, third-party Model Garden partner models (Llama, Mistral, ...), or any OpenAI-compatible endpoint — with no code change required to switch one.

## The two orthogonal axes

`ModelPolicy` (`packages/core/src/types/model-policy.ts`) now carries `policy` (the `pinned`/`portable`/`commodity` *tier*, governing fallback/retry) and `vendor` (which company's model runs the call) as independent fields. Switching vendor never changes a step's fallback behaviour; switching tier never changes which company answers. `vendor` absent means `anthropic` — every pre-existing agent keeps working with zero changes to its behaviour.

## Four vendors, one router

`DefaultModelRouter` (`router/model-router.ts`) dispatches on vendor via `ModelRouterAdapters = { anthropic, gemini?, "model-garden"?, "openai-compatible"? }`. `anthropic` is the only required adapter; the other three are built only when their own env vars are present (`create-model-router-from-env.ts`), and a step that requests an unconfigured vendor gets a specific, actionable error naming the exact env vars — at the point of use, not at boot.

- **`anthropic`** — unchanged from the earlier task (Agent Platform default, direct-API fallback).
- **`gemini`** (new) — `GeminiAdapter` via `@google/genai`. Agent Platform route (ADC, same auth story as Claude) or direct Gemini Developer API (`GEMINI_API_KEY`). Structured output via `responseJsonSchema` (real JSON Schema, not Gemini's OpenAPI-subset `responseSchema`), reusing the same object-root wrap/unwrap (`root-object-schema.ts`) every other adapter uses for the ReAct-turn discriminated union.
- **`model-garden`** (new) — Agent Platform's Model-as-a-Service OpenAI-compatible endpoint for third-party/open partner models. Reuses `OpenAICompatibleAdapter` wire mechanics; auth is the interesting part — MaaS needs a refreshing ADC bearer token, not a static key, so `vertex-model-garden-client.ts` exports a `fetch` wrapper that injects a live token from `google-auth-library` on every request. Deliberately gated on its own `MODEL_GARDEN_PROJECT_ID` rather than falling back to `GOOGLE_CLOUD_PROJECT` — a vendor switch this consequential shouldn't happen by accident of other GCP config.
- **`openai-compatible`** (generalized from the earlier task's placeholder) — real OpenAI or a self-hosted gateway (LiteLLM). Adapter constructor widened to accept a client-resolver function (needed for Gemini/Model Garden's per-region client memoization) while staying positionally backward compatible.

## Switching a step's model without touching code

Every one of the 25 `modelPolicy` declarations across 24 agent files now resolves through `resolveModelPolicy(stepId, defaultPolicy)` (`router/step-model-policy.ts`), which checks `MODEL_STEP_<STEP_ID>_VENDOR` / `MODEL_STEP_<STEP_ID>_MODEL` before falling back to the code default (`<STEP_ID>` = the step's own `id`, upper-cased, non-alphanumeric runs collapsed to one underscore). Setting vendor without model throws at startup — a step's default model id is shaped for its default vendor and won't resolve against a different one. Verified live against a real agent class (`BlogDraftAgent`): default resolves to `{pinned, claude-sonnet-4-6}` unchanged; `MODEL_STEP_BLOG_DRAFT_VENDOR=gemini` + `MODEL_STEP_BLOG_DRAFT_MODEL=gemini-2.5-pro` resolves to `{pinned, gemini-2.5-pro, vendor: gemini}`.

A fallback model (`portable`/`commodity`) always resolves against the *same* vendor as the primary — swapping vendor and model together on a transient failure would silently change the structured-output mechanism, pricing, and failure mode all at once.

## Files touched (44)

New: `router/adapters/gemini-adapter.ts`, `router/adapters/vertex-model-garden-client.ts`, `router/step-model-policy.ts`, plus `__tests__/gemini-adapter.test.ts`, `__tests__/vertex-model-garden-client.test.ts`, `__tests__/step-model-policy.test.ts`.

Rewritten: `types/model-policy.ts`, `router/model-router.ts`, `router/create-model-router-from-env.ts`, `router/adapters/openai-compatible-adapter.ts`, `__tests__/model-router.test.ts`; extended `__tests__/create-model-router-from-env.test.ts`.

Modified: `router/index.ts`, `router/adapters/index.ts`, `telemetry/pricing.ts` (added confirmed Model Garden partner pricing — Llama 3.3 70B, Mistral Small/Medium — cross-checked against Google's own pricing page 2026-08-20; Llama 3.1 405B and Mistral Large weren't listed there and were deliberately left out rather than guessed), `packages/core/package.json` (+`@google/genai`, +`google-auth-library`), `.env.example`, `README.md` (new "Choosing a model vendor for any step" section), `package-lock.json`.

All 25 `modelPolicy` sites: every file under `agents/*/src/agent/*.ts` that declares one (blog, branded-shorts ×3, campaign-orchestrator, instagram ×4, intel-report, landing-builder ×4, linkedin, newsletter, reddit, reputation ×5, seo-geo ×2, x-agent).

## Verification status

- Root `tsc --noEmit` clean; all 31 workspaces build in dependency order.
- `packages/core`: 429/429 tests (up from 382 after the prior task). Every other workspace's suite passes. The one failure anywhere in the repo is `agents/instagram-agent`'s real-Chromium render test — pre-existing, environmental (documented in its own source as self-skipping when Chromium isn't installed), uses a fully mocked router, unrelated to model vendor selection. Confirmed unrelated by tracing the test: it never calls a real model adapter.
- `npm run demo:e2e` and `npm run smoke` both pass end to end with the newly-wired agent files.
- Secret-hygiene constraints (RFC-01 §16.3's pre-existing regression test) respected throughout: `new OpenAI({...})` for the Model Garden client lives only in `create-model-router-from-env.ts` (the one sanctioned composition root, same rule Anthropic-SDK construction already followed); `vertex-model-garden-client.ts` itself exports only pure helper functions, no client/credential construction.

## Known gaps / next steps

1. No live credential check yet for `gemini`, `model-garden`, or `openai-compatible` — only Claude's Agent Platform route has a real smoke script (`npm run smoke:agent-platform`). Worth adding an equivalent one-real-call smoke check per vendor before relying on any of them in production, the same way that script now catches "credentials resolve" vs "model enabled" vs "model served here" as three separate failure modes.
2. Model Garden partner-model pricing is incomplete by design (see above) — add a row in `telemetry/pricing.ts` the same day any agent actually adopts a Model Garden model, or its cost silently reports at Sonnet's rate.
3. `_to_delete/` at the repo root now has two tarballs (`src.tgz` from the earlier round-trip, plus this task's `_incoming-vendor-switching-update.tar.gz`) — `device_bash` can't delete files, so these need a manual `rm` from Shlomi's own machine.
4. No agent in this system sets `vendor` to anything but the default yet — this task is the mechanism, not a decision to actually run any step on Gemini/Model Garden/OpenAI in production. That choice (if/when) is a separate call.