import { z } from "zod";

/**
 * Fixed, client-slug-independent relative paths for the artifacts MAKE
 * generates inside one client's `OUTPUT_PATH/site` (RFC-07 §4). Client
 * identity already lives in the directory tree itself
 * (`<engineClientsRoot>/<clientSlug>/site/...`), so the files within it need
 * no slug in their own names — that simplification lets both
 * `agents/landing-builder-agent` (the writer) and this package's
 * `landing.gate` (the reader) share ONE source of truth for where these
 * artifacts live, instead of each re-deriving a slug-templated path that
 * could drift out of sync.
 */
export const GENERATED_CONTENT_RELATIVE_PATH = "src/content/generated.ts";
export const GENERATED_MANIFEST_RELATIVE_PATH = "src/content/generated.manifest.json";
export const GENERATED_CARRY_FORWARD_PLACEMENT_RELATIVE_PATH = "src/content/generated.carryforward.json";
export const GENERATED_LAYOUT_RELATIVE_PATH = "src/app/layout.tsx";

/**
 * Where MAKE placed each `carryForward[]` item (ENGINE-SPEC §3: "Inject
 * carryForward tools into the right sections") — written after COMPOSE
 * decides `carryForwardPlacement`, read back by both a rebuild (FEEDBACK.md
 * §1's durable state) and `landing.gate`'s completeness check, which uses it
 * to scope its presence check to the *specific* section an item claims to
 * live in, rather than the whole site (the Deep Parity Audit's finding that
 * a blind, unconditional claim could never fail is what this file structure
 * exists to close).
 */
export const CarryForwardPlacementFileSchema = z.array(
  z.object({
    what: z.string().min(1),
    section: z.string().min(1),
  }),
);
export type CarryForwardPlacementFile = z.infer<typeof CarryForwardPlacementFileSchema>;
