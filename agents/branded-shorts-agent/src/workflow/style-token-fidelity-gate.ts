import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success } from "@agent-engine/tool-common";
import { StyleCandidateSchema } from "./types.js";

const TOOL_VERSION = "1.0.0";

export const StyleTokenFidelityInputSchema = z.object({
  candidates: z.array(StyleCandidateSchema),
  /** `client.getBrand()`'s loose, free-form record — merged onto the draft via `selfCritique.gateArgs`, same static-fields convention `numbersSourced`'s doc comment describes. */
  brand: z.record(z.string(), z.unknown()),
});
export type StyleTokenFidelityInput = z.infer<typeof StyleTokenFidelityInputSchema>;

const HEX_PATTERN = /#[0-9a-f]{6}/gi;

/**
 * `gate.styleTokenFidelity` (P1#6 audit fix): SKILL.md's per-client
 * onboarding step 2 states "token fidelity is a HARD GATE — off-palette caps
 * the score," but nothing mechanically checked it — three candidates whose
 * prose merely CLAIMED brand-derived colors were accepted unverified. This
 * is the same "arithmetic backstops judgment" pattern as `gate.brandCompliance`
 * / `gate.numbersSourced`: every literal hex code a candidate declares in
 * `paletteTokensUsed` must appear somewhere in the client's actual brand
 * data, or the candidate is off-palette by construction, regardless of how
 * convincing its prose is.
 *
 * The check is deliberately mechanical and honest about its own limits: it
 * can only verify hex codes the candidate EXPLICITLY declares (hence
 * `StyleCandidateSchema.paletteTokensUsed` being a required, structured
 * field rather than trusting free-text `paletteUsage` prose to contain
 * one), and it can only check that a cited hex appears SOMEWHERE in
 * `client.getBrand()`'s record — that record has no canonical schema in
 * this repo (RFC-01 §9's "no admin-authoring system wired up" convention
 * every `karos-client` tool already documents), so a false negative is
 * possible if a client's brand kit doesn't expose its palette as literal hex
 * strings. That is a real, named limit, not silently pretended away.
 */
export const styleTokenFidelityGate = defineTool<StyleTokenFidelityInput, GateVerdict>({
  name: "gate.styleTokenFidelity",
  version: TOOL_VERSION,
  inputSchema: StyleTokenFidelityInputSchema,
  async execute({ candidates, brand }) {
    const brandText = JSON.stringify(brand).toLowerCase();
    const violations: string[] = [];

    for (const candidate of candidates) {
      const offPalette = candidate.paletteTokensUsed.filter((hex) => !brandText.includes(hex.toLowerCase()));
      if (offPalette.length > 0) {
        violations.push(`candidate "${candidate.name}" cites ${offPalette.join(", ")}, which do${offPalette.length === 1 ? "es" : ""} not appear anywhere in the client's brand kit`);
      }
      // Defensive: also catch a hex mentioned in prose but never declared in paletteTokensUsed at all —
      // still off-palette-checked, since an undeclared color is exactly as unverifiable as a wrong one.
      const proseText = `${candidate.description} ${candidate.paletteUsage} ${candidate.captionTreatment} ${candidate.graphicsDirection} ${candidate.endcardTreatment}`;
      const proseHexes = new Set((proseText.match(HEX_PATTERN) ?? []).map((h) => h.toLowerCase()));
      for (const hex of proseHexes) {
        if (!candidate.paletteTokensUsed.some((declared) => declared.toLowerCase() === hex)) {
          violations.push(`candidate "${candidate.name}" mentions ${hex} in its description but never declares it in paletteTokensUsed`);
        }
      }
    }

    if (violations.length > 0) {
      return success<GateVerdict>({
        verdict: "content_fail",
        evidence: violations,
        reason: `token fidelity violated (SKILL.md hard gate): ${violations.join("; ")}`,
        toolVersion: TOOL_VERSION,
      });
    }

    return success<GateVerdict>({
      verdict: "pass",
      evidence: [`${candidates.length} candidate(s), every declared palette token verified against the client's brand kit`],
      toolVersion: TOOL_VERSION,
    });
  },
});
