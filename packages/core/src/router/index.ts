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
