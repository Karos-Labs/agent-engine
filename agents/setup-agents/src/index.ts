/**
 * Channel setup — the onboarding routine each drafting agent runs for itself.
 *
 * This was two standalone products, `linkedin-setup-agent` and
 * `reddit-setup-agent`, and the work they did is unchanged. What is gone is
 * their place in the catalog: sequencing setup before drafting was left to the
 * person running them, nothing enforced it, and getting it wrong was silent —
 * a LinkedIn run without a charter simply drafted without one.
 *
 * `linkedin-agent` and `reddit-agent` now call these directly as a pre-flight
 * step. The package keeps its name and its `types.ts`, which is still the
 * contract for what a portal form may submit.
 */
export * from "./workflow/types.js";
export * from "./workflow/channel-setup.js";
