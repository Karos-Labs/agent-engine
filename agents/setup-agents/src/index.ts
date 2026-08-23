/**
 * The two onboarding agents: LinkedIn seat intake and Reddit community setup.
 *
 * One package because they are the same shape of thing — record a filled form
 * as the charter a drafting agent will later read — and neither is big enough
 * to earn its own. Their workflows share `types.ts` and nothing else.
 */
export * from "./workflow/types.js";
export * from "./workflow/create-linkedin-setup-workflow.js";
export * from "./workflow/create-reddit-setup-workflow.js";
