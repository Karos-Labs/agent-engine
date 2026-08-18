/**
 * The three roots every `karos-landing` tool is bound to at construction
 * time (RFC-07 §7) — never accepted as a tool argument, so a model can never
 * point a run at an arbitrary filesystem location (the same "tenant is
 * structural, never a raw argument" rule `enforceWriteFence`/`WorkspaceStore`
 * already apply to `clientSlug` — this repo's Layer 3 packages extend it to
 * every root a tool can touch).
 */
export interface LandingEngineConfig {
  /** `engine/template/` — the canonical, read-only FORGE-proven kit (ENGINE-SPEC §13). Never a write target. */
  templateRoot: string;
  /** `engine/clients/` — each client's build output lives at `<engineClientsRoot>/<clientSlug>/site` (AGENT-INVOCATION.md §2's `OUTPUT_PATH`). */
  engineClientsRoot: string;
  /** Root holding each client's assembled input bundle (AGENT-INVOCATION.md §1) at `<bundlesRoot>/<clientSlug>` — `brand.json` + `intake.md` + `assets/` + `oldSite/`. */
  bundlesRoot: string;
}
