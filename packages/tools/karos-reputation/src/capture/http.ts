/**
 * Re-export shim. The bounded-fetch stack this file used to hold now lives in
 * `@agent-engine/tool-common`'s `http.ts`, unchanged — same signatures, same
 * 15s default budget, same `TimeoutError`/`AbortError` classification — so the
 * capture adapters below it keep the exact stack they were written and tested
 * against while the repo has ONE outbound HTTP stack rather than four.
 *
 * That promotion is the action `docs/AUDIT-2026-08-25-architecture-optimization-plan.md:56`
 * (matrix row R5) prescribes for this exact file: *"Promote reputation's
 * `fetchWithDeadline` + a shared retry policy into `tools/common`; adopt
 * everywhere."* The shared retry policy (`fetchWithRetry`) — the half R5 says
 * existed in no tool but `image.generate` — lives beside it there.
 *
 * Kept as a shim rather than deleted so `appstore.ts`/`gbp.ts` keep their
 * relative `./http.js` imports and nothing about this package's behaviour
 * moves in the same change that moves the code.
 */
export { CAPTURE_TIMEOUT_MS, describeFetchFailure, fetchWithDeadline, isDeadlineError } from "@agent-engine/tool-common";
export type { CaptureFetch } from "@agent-engine/tool-common";
