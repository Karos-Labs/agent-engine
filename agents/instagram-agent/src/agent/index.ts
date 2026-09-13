export * from "./instagram-angle-agent.js";
export * from "./instagram-brief-agent.js";
// Phase 2, item N — the Template Studio's three setup-time agents. They run
// at most once per client per 120 days, on the separate setup budget.
export * from "./instagram-design-brief-agent.js";
export * from "./instagram-template-designer-agent.js";
export * from "./instagram-template-set-review-agent.js";
// Phase 3, item Q — the setup-time art director. Runs at most once per client
// per 90 days, on the same setup budget as the Template Studio above.
export * from "./instagram-art-director-agent.js";
export * from "./instagram-research-agent.js";
export * from "./instagram-copy-agent.js";
export * from "./instagram-image-vetting-agent.js";
// Phase 4, RFC-15 §6 — the native editor. Replaces the Phase 0 Haiku fluency
// judge (`instagram-language-fluency`, a `DynamicAgent`): a new class id
// because the step moves vendor `anthropic` -> `gemini`.
export * from "./instagram-native-editor-agent.js";
// Phase 5, RFC-18 §6.1 — the post packager. Runs ONCE PER REVISION, after the
// drafting loop breaks, and writes the hashtags, the per-slide alt text and the
// first comment's prose. A `BaseAgent` for the same reason the native editor is
// one: `altText` is an `object[]` and the flat field DSL has no such type.
export * from "./instagram-post-packager-agent.js";
export * from "./instagram-visual-qa-agent.js";
// Phase 4 (#110) — the concept/metaphor direction for generated images. It was
// never exported here, which is how it stayed outside the reach of
// `no-premium-models.test.ts` while being a live `claude-sonnet-4-6` step in
// every run. Exported now so the roster that suite derives really is every
// agent this package ships.
export * from "./instagram-concept-agent.js";
