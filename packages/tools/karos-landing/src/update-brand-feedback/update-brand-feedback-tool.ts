import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError } from "@agent-engine/tool-common";
import type { LandingEngineConfig } from "../config.js";
import { BrandJsonSchema, BrandFeedbackRoundSchema } from "../types.js";

const TOOL_VERSION = "1.0.0";

export const UpdateBrandFeedbackInputSchema = z.object({
  entry: BrandFeedbackRoundSchema,
});
export type UpdateBrandFeedbackInput = z.infer<typeof UpdateBrandFeedbackInputSchema>;

export interface UpdateBrandFeedbackResult {
  lastRound: number;
}

/**
 * `landing.updateBrandFeedback` (FEEDBACK.md §5: the `brand.json.feedback`
 * append-only rebuild audit trail — "the contract is the per-build ledger").
 * The Deep Parity Audit found this was never persisted anywhere: every
 * rebuild recomputed `(brand.feedback?.lastRound ?? 0) + 1`, which — because
 * nothing ever wrote `lastRound` back — always evaluated to `1`, forever,
 * with no guard against silently re-applying the same round twice.
 *
 * This is the ONE narrow, non-arbitrary write this package makes into the
 * otherwise-read-only bundle root (`landing.readBundle`'s domain): always
 * exactly `<bundlesRoot>/<clientSlug>/brand.json`, never a caller-supplied
 * path — there is no relative-path argument here at all, so there is no
 * traversal surface to fence in the first place (narrower than the site
 * sandbox, which at least accepts a relative path to validate).
 *
 * Enforces FEEDBACK.md §4 step 0's "Reject if round != next expected"
 * idempotency rule directly: `entry.round` must equal
 * `(brand.feedback?.lastRound ?? 0) + 1` or the call is a `content_fail`,
 * never silently accepted — this is what makes a second rebuild attempt
 * against the same round a real, catchable error instead of a silent
 * re-application.
 */
export function createUpdateBrandFeedback(config: LandingEngineConfig) {
  return defineTool<UpdateBrandFeedbackInput, UpdateBrandFeedbackResult>({
    name: "landing.updateBrandFeedback",
    version: TOOL_VERSION,
    inputSchema: UpdateBrandFeedbackInputSchema,
    async execute({ entry }, { ctx }) {
      const brandPath = path.join(config.bundlesRoot, ctx.clientSlug, "brand.json");

      let raw: string;
      try {
        raw = await fs.readFile(brandPath, "utf8");
      } catch (err) {
        return toolingError(`could not read brand.json at "${brandPath}": ${err instanceof Error ? err.message : String(err)}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return toolingError(`brand.json at "${brandPath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }

      const brand = BrandJsonSchema.safeParse(parsed);
      if (!brand.success) {
        return toolingError(`brand.json at "${brandPath}" does not match the brand contract: ${brand.error.message}`);
      }

      const expectedRound = (brand.data.feedback?.lastRound ?? 0) + 1;
      if (entry.round !== expectedRound) {
        return contentFail<UpdateBrandFeedbackResult>(
          `round ${entry.round} was submitted, but ${expectedRound} is the next expected round for this client (FEEDBACK.md §4 step 0's idempotency rule) — refusing to silently re-apply or skip a round`,
        );
      }

      const updatedBrand = {
        ...brand.data,
        feedback: {
          lastRound: entry.round,
          rounds: [...(brand.data.feedback?.rounds ?? []), entry],
        },
      };

      await fs.writeFile(brandPath, `${JSON.stringify(updatedBrand, null, 2)}\n`, "utf8");
      return success<UpdateBrandFeedbackResult>({ lastRound: entry.round });
    },
  });
}
