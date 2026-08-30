import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";

/**
 * Brand Voice as a first-class, ALWAYS-LATEST drafting input (SCRUM-380 /
 * D1-v2).
 *
 * ## Where Brand Voice actually lives
 *
 * It is already a BrandKit field: `ClientBrand.voice`
 * (`packages/tools/karos-client/src/get-brand.ts`), read through
 * `client.getBrand`, written by the portal into
 * `{clientSlug}/client/brand.json`. It is the same shape of field as
 * `language` (SCRUM-309 / AU31) and is threaded the same way. No portal
 * schema change is needed for it to exist — only for it to stay fresh, which
 * is what this module is about.
 *
 * (It also appears a second time as a synced knowledge document,
 * `contextDocs[].docType === "brand-voice"` via `client.getKnowledge`. That
 * copy is a mirror of an onboarding doc, distilled by
 * `buildClientKnowledgeContext` and capped at 1200 chars — useful prose, but
 * a snapshot of a document, not the live field. When the two disagree the
 * BrandKit field is the one an editor just changed, so it is the one this
 * reads.)
 *
 * ## Why this is not a `wf.step.code`
 *
 * THIS IS THE POINT OF THE MODULE, so it is stated plainly rather than left
 * to be inferred from the signature: `wf.step.code(id, fn)` memoizes. A
 * completed checkpoint is returned verbatim on every later pass without
 * calling `fn` again (`step-code.ts`) — that is the entire resumability
 * story, and for research pulls, gates, and persistence it is exactly right.
 *
 * For Brand Voice it is exactly wrong, and the failure is not hypothetical.
 * An Intel Report run pauses at its human `batch_review` gate with a 24-hour
 * timeout. The realistic sequence is: a reviewer reads the draft, decides the
 * voice is off, edits Brand Voice in the portal, and clicks "revise". The
 * revision then re-drafts — with the brand kit that was checkpointed
 * yesterday, before the edit, because `00-load-client-context` completed on
 * the first pass and is never re-run. The reviewer's own edit is invisible to
 * the draft their edit was meant to fix, and nothing anywhere reports that.
 *
 * So this helper takes `tools` and `ctx` and deliberately NOT a
 * `WorkflowContext`: there is no step id to pass, because there is no
 * checkpoint. It is a plain read on every pass. The cost of that is one
 * `client/brand.json` GET per attempt (no model tokens, no external API), and
 * the benefit is that "always-latest" is a property of the mechanism rather
 * than a claim in a comment.
 *
 * ## Failure posture
 *
 * Best-effort, never blocking, same as every other context read in this
 * directory. A caller passes the brand kit it already has from its own
 * checkpointed load step as `fallback`; if the live read fails or reports
 * anything but success, that fallback is returned unchanged and the run
 * drafts exactly as it would have before this existed. A freshness
 * improvement must never be able to stop a report from being written.
 */

/** The loose brand-kit shape this module needs — deliberately not importing `ClientBrand`, which lives in the tools layer. */
export type BrandKitLike = Readonly<Record<string, unknown>>;

export interface LatestBrandVoice {
  /**
   * The whole brand kit as of NOW, or `fallback` if the live read failed.
   * Callers thread this in place of a checkpointed brand kit.
   */
  readonly brand: BrandKitLike;
  /**
   * `brand.voice`, trimmed, when it is a non-empty string — the first-class
   * field itself, surfaced separately so a drafting input can name it
   * (`brandVoice: "..."`) instead of burying it one level down inside a
   * brand-kit blob the model has to go looking through.
   */
  readonly voice?: string;
  /** True when the live read succeeded. False means `brand` is the caller's fallback. */
  readonly fresh: boolean;
}

/** `brand.voice` when it is a usable non-empty string, trimmed. */
export function readBrandVoiceField(brand: BrandKitLike | undefined): string | undefined {
  const voice = brand?.["voice"];
  if (typeof voice !== "string") return undefined;
  const trimmed = voice.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Re-reads the tenant's brand kit through `client.getBrand`, uncached and
 * uncheckpointed, and returns it alongside the Brand Voice field pulled out
 * as a first-class value.
 *
 * `fallback` is what to use when the read cannot be made — normally the brand
 * kit the workflow's own `00-load-client-context` step already checkpointed.
 */
export async function readLatestBrandVoice(
  tools: AgentToolRegistry,
  ctx: AgentContext,
  fallback: BrandKitLike = {},
): Promise<LatestBrandVoice> {
  const getBrand = tools["client.getBrand"];
  if (!getBrand) {
    return { brand: fallback, fresh: false, ...voiceField(fallback) };
  }
  try {
    const outcome = await getBrand.execute({}, { ctx });
    if (outcome.status !== "success") {
      return { brand: fallback, fresh: false, ...voiceField(fallback) };
    }
    const brand = (outcome.result ?? {}) as BrandKitLike;
    return { brand, fresh: true, ...voiceField(brand) };
  } catch (error) {
    console.error("readLatestBrandVoice: could not re-read the brand kit, using the last loaded one", error);
    return { brand: fallback, fresh: false, ...voiceField(fallback) };
  }
}

/** `exactOptionalPropertyTypes`-safe spread of the optional `voice` field. */
function voiceField(brand: BrandKitLike | undefined): { voice?: string } {
  const voice = readBrandVoiceField(brand);
  return voice !== undefined ? { voice } : {};
}
