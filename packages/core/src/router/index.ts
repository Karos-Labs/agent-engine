export * from "./aliases.js";
export * from "./model-router.js";
export * from "./step-model-policy.js";
export * from "./client-model-policy.js";
export * from "./create-model-router-from-env.js";
export * from "./adapters/index.js";
// SCRUM-380 (D1-v2). Additive: a NEW module, so nothing already exported from
// this barrel changes shape. Deliberately not folded into
// `step-model-policy.js` — that file is another in-flight ticket's target
// (AU34 / SCRUM-312), and this is a different decision anyway: which model for
// THIS instance, versus which model for this deployment.
export * from "./context-document-routing.js";
// AU35 (SCRUM-313). Additive: a new module built on top of AU33's catalog
// (model-capabilities.js, itself not re-exported from this barrel — see that
// gap noted in this ticket's report) and AU34's content-language logic
// (client-model-policy.js). Exported here so the engine surface actually
// carries it — a recommender whose export nobody can reach is as untestable
// from outside this package as one trapped inside a view.
export * from "./model-recommender.js";
// Phase 4 (RFC-15 §8). The AU33 catalog itself, finally on the barrel — the gap the AU35 comment above has
// been pointing at. Two Phase 4 test files needed `MODEL_CAPABILITIES` / `assertModelCatalogued` to assert
// against the REAL cost tiers rather than a restatement of them, and with no barrel export the only way to
// reach them was `@agent-engine/core/dist/router/model-capabilities.js` — a deep import into a build artifact,
// which is both the repo's first and a dependency on `dist/`'s internal layout rather than on this package's
// public surface. Additive: every name here was already reachable through that path, and nothing else on this
// barrel re-declares one.
export * from "./model-capabilities.js";
