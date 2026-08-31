import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import type { WorkflowContext } from "./context.js";

/**
 * SCRUM-241 (T-A9): the shared read side of C1 (SCRUM-209)'s projected
 * context documents, for the four fixed-workflow agents this ticket grounds
 * (`instagram-agent`, `landing-builder-agent`, `branded-shorts-agent`,
 * `intel-report-agent` — `seo-geo-agent` is Batch 2's file and is excluded,
 * see this ticket's own report).
 *
 * `client.getContextDoc` (T-A8) already does the hard part: `not_available`
 * for a missing document *and* for a present-but-empty one, never a throw.
 * What was missing was a caller — nothing in any fixed-workflow agent had
 * ever invoked it. This is the one place that call is made, matching the
 * exact best-effort/checkpointed shape `readClientIntelContext` and
 * `readPastFeedback` (`history-dedup.ts`) already established for every
 * other optional drafting input in this package: a missing or
 * not-yet-projected document degrades to `undefined`, never to a thrown
 * error and never to a held run. T-A9's own acceptance criteria is explicit
 * that a run with every context doc absent must still complete — this
 * function is how that holds structurally rather than by convention: the
 * only way out of it is `undefined`.
 *
 * Checkpointed (unlike `readLatestBrandVoice`'s deliberate always-live
 * read): a context document is client-authored reference material edited on
 * a much slower cadence than a mid-review Brand Voice tweak, so the
 * "freshness across a revision" case `brand-voice.ts` documents does not
 * apply here, and a stable per-run value is what makes the returned
 * markdown attributable to one step record.
 */
export async function readContextDoc(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  docType: string,
  stepId: string,
): Promise<string | undefined> {
  return (
    (await wf.step.code(stepId, async () => {
      const getDoc = tools["client.getContextDoc"];
      if (!getDoc) return null;
      try {
        const outcome = await getDoc.execute({ docType }, { ctx });
        if (outcome.status !== "success") return null;
        const markdown = (outcome.result as { markdown?: unknown }).markdown;
        // JSON round-trip note: `null`, never `undefined`, crosses the
        // checkpoint — same rule `02c-load-brand-kit`/`readClientIntelContext`
        // document; `undefined` comes back as `null` on a resumed run, so
        // returning `undefined` here directly would make a first run and a
        // resumed run disagree about this step's own output shape.
        return typeof markdown === "string" && markdown.trim().length > 0 ? markdown.trim() : null;
      } catch (error) {
        console.error(`${stepId}: could not read the "${docType}" context document, continuing without it`, error);
        return null;
      }
    })) ?? undefined
  );
}
