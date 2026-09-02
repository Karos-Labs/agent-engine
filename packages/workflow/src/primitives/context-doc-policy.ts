import type { RunKind } from "@agent-engine/core";
import { WorkflowBlockedIntake } from "./signals.js";

/**
 * SCRUM-242 (T-A10) — stop failing open.
 *
 * The defect this module exists to remove, in the ticket's own words:
 * *"THE CURRENT STATE — generic output that looks identical to grounded
 * output — IS THE WORST OF THE THREE OPTIONS. x-agent sets `{}` and keeps
 * writing."* T-A9 wired `client.getContextDoc` (T-A8) into four
 * fixed-workflow agents, but a missing/empty context document
 * (`not_available`) degraded silently to `undefined` at every call site —
 * the agent drafted exactly as if grounding had never been asked for, and
 * nothing downstream could tell the difference between "genuinely grounded"
 * and "the doc was never there."
 *
 * The architectural instruction, and the whole point of this ticket: do NOT
 * scatter a per-agent `if` across four workflow files deciding whether a
 * missing doc should hold the run or let it through. Put the decision in
 * exactly one place — {@link CONTEXT_DOC_POLICY}, one table, agent id ->
 * `"block"` | `"degraded"` — and have exactly one function,
 * {@link enforceContextDocPolicy}, act on it. Every call site becomes:
 * read the docs (T-A9's `readContextDoc`), then hand the results to this
 * function. Nothing at the call site branches on the decision itself — the
 * table does, and a fifth agent's policy is a new row here, never a new
 * `if` in a fifth workflow file.
 *
 * ## What counts as "missing required context"
 *
 * Deliberately: **every** context doc this agent reads is absent — not "at
 * least one." An agent grounded in two doc types (intel-report-agent's
 * `target-audience` + `market-strategy`) that has ONE of them projected is
 * genuinely, partially grounded; that is real signal reaching the prompt,
 * not the "looks grounded but isn't" failure this ticket targets. Only the
 * total-absence case — zero of this agent's context docs are there at all —
 * is what T-A9's own "still completes" acceptance criterion described and
 * what this ticket exists to change. (T-A9's own per-field influence tests,
 * which each leave the OTHER doc type absent on purpose to isolate one
 * variable, depend on this reading — see their own doc comments.)
 *
 * ## BLOCK vs. DEGRADED, mechanically
 *
 * `"block"` throws {@link WorkflowBlockedIntake} — the existing, established
 * "client-side gap, not an agent fault" signal (RFC-01 §16.2): the run
 * resolves to `blocked_intake`, never drafts, and the thrown message (this
 * function's own `reason` string, naming the agent, the missing doc types,
 * and this row's rationale) becomes both `RunRecord.reason` and
 * `serializeToDynamicAgentRunReport`'s `domainOutcomeReason` — a stated
 * reason that reaches the same run report the portal already reads, with no
 * new field required.
 *
 * `"degraded"` does not throw: it returns a {@link DegradedContextGroundingMarker}
 * for the caller to attach wherever ITS output actually surfaces — the
 * deliverable persisted via `ledger.writeDeliverable`, and/or the workflow's
 * own typed return value. A field nobody displays is the pre-T-A10 defect
 * with extra steps, so the marker is designed to be spread directly into
 * whatever a human or the portal actually looks at, not left to sit only in
 * this step's own checkpoint.
 *
 * ## The proposed rows
 *
 * States the table below as this ticket's PROPOSAL, not settled fact (see
 * SCRUM-242's own text and this ticket's report):
 *
 * | Agent | Decision | Rationale |
 * |---|---|---|
 * | `intel-report-agent` | BLOCK | Client-facing deliverable that names external parties (competitors) — ungrounded is worse than absent. |
 * | `landing-builder-agent` | BLOCK | Produces a published artefact. |
 * | `instagram-agent` | DEGRADED + marker | Channel copy; a human reviews it, and the marker is what makes the gap visible. |
 * | `branded-shorts-agent` | DEGRADED + marker | Same. |
 * | `seo-geo-agent` | row present, NOT wired | `agents/seo-geo-agent/src/workflow/create-seo-geo-agent-workflow.ts` is Batch 2's exclusive file (see T-A9/T-A10's carve-out) — nothing calls `enforceContextDocPolicy("seo-geo-agent", ...)` anywhere in this repo. The row exists so the table is complete for all five agents T-A9's own ticket named, and so whoever wires seo-geo-agent's grounding after Batch 2 lands finds a decision already proposed here instead of having to invent one from scratch. |
 *
 * Flipping a decision — say, promoting `instagram-agent` to BLOCK after a
 * real incident — is a one-line edit to one row in this table. No workflow
 * file changes.
 *
 * ## SCRUM-388 — the bootstrap deadlock, and `bootstrapExempt`
 *
 * T-A10 (this table) and T-B19 (onboarding) were each individually correct
 * and each passed its own acceptance criteria, and the deadlock between them
 * exists only because both merged, across two repos, in different batches —
 * see this ticket's own report for the full account. In short:
 * `intel-report-agent`'s BLOCK row is right for a RECURRING run — a client
 * with documents shipping an ungrounded report is worse than shipping
 * nothing. But onboarding dispatches this exact agent to PRODUCE
 * `target-audience`/`market-strategy` in the first place — so a fresh
 * client's very first run hard-blocks on documents that run exists to
 * create, and no deliverable is ever produced.
 *
 * `bootstrapExempt: true` on a row means: a `"block"` decision does not
 * throw for a `runKind: "setup"` run — it degrades instead, with the same
 * visible marker a DEGRADED row produces, so the bootstrap report is
 * generated but visibly, honestly marked as the ungrounded one it is.
 * **Every recurring run still BLOCKs exactly as before** — this is an
 * exemption for the run that is producing the grounding documents, not a
 * weakening of the guarantee for every run after it. Grounding a report in
 * documents it is itself generating would be circular; two things make
 * shipping it anyway acceptable rather than merely convenient: it is
 * necessarily the FIRST report a client ever sees (never a recurring one),
 * and it still carries the degraded marker so nobody mistakes it for a
 * grounded one.
 */
export type ContextDocPolicyDecision = "block" | "degraded";

export interface ContextDocPolicyRow {
  decision: ContextDocPolicyDecision;
  /** Why this agent got this row. Surfaced verbatim in the BLOCK reason / DEGRADED marker — update this alongside the decision, not instead of it. */
  rationale: string;
  /**
   * SCRUM-388: only meaningful on a `"block"` row. When true, a
   * `runKind: "setup"` run degrades (with a marker) instead of throwing —
   * every OTHER `runKind` still BLOCKs. See this module's own doc comment,
   * "SCRUM-388 — the bootstrap deadlock," for why this exists and why it is
   * scoped to bootstrap only, not a general downgrade of the row's decision.
   */
  bootstrapExempt?: boolean;
}

export const CONTEXT_DOC_POLICY: Readonly<Record<string, ContextDocPolicyRow>> = {
  "intel-report-agent": {
    decision: "block",
    rationale: "output is a client-facing deliverable that names external parties (competitors) — ungrounded is worse than absent",
    // SCRUM-388: bootstrap exemption. A fresh client's onboarding run
    // dispatches this exact agent to PRODUCE target-audience/market-strategy —
    // without this, BLOCK fires on the run that creates the documents it is
    // checking for, and onboarding can never produce a first deliverable.
    // Recurring runs are unaffected: BLOCK still fires for every run whose
    // runKind is not "setup". See this module's doc comment.
    bootstrapExempt: true,
  },
  "landing-builder-agent": {
    decision: "block",
    rationale: "produces a published artefact",
  },
  "instagram-agent": {
    decision: "degraded",
    rationale: "channel copy; a human reviews it, and the marker is what makes the gap visible",
  },
  "branded-shorts-agent": {
    decision: "degraded",
    rationale: "channel copy; a human reviews it, and the marker is what makes the gap visible",
  },
  // NOT wired to any call site — agents/seo-geo-agent/src/workflow/create-seo-geo-agent-workflow.ts
  // is Batch 2's exclusive file. Row present so this table is complete for all
  // five agents T-A9 named; see this module's own doc comment above.
  "seo-geo-agent": {
    decision: "block",
    rationale: "not wired to any call site (Batch 2 owns create-seo-geo-agent-workflow.ts) — decision proposed here for whoever wires it next, not exercised today",
  },
} as const;

/**
 * The visible marker a DEGRADED decision produces. `contextGroundingStatus`
 * is a literal (not a bare boolean) so a future third state doesn't need a
 * breaking rename, and every field here is meant to be spread directly into
 * a persisted deliverable or a workflow's own typed result — see this
 * module's own doc comment for why an internal-only field is not enough.
 */
export interface DegradedContextGroundingMarker {
  contextGroundingStatus: "degraded";
  agentId: string;
  missingDocTypes: readonly string[];
  reason: string;
}

export type ContextDocPolicyOutcome = { decision: "ok" } | { decision: "degraded"; marker: DegradedContextGroundingMarker };

/**
 * The one shared enforcement point every grounded agent calls after reading
 * its own context docs (T-A9's `readContextDoc`). `docs` is a map of doc
 * type -> markdown-or-`undefined`, exactly `readContextDoc`'s own return
 * shape — the caller does no interpretation of its own before handing this
 * function the raw results.
 *
 * `runKind` (SCRUM-388) is optional — a caller that never needs the
 * bootstrap exemption can omit it, and the behavior is identical to before
 * this ticket: `undefined` never matches `"setup"`, so a row's
 * `bootstrapExempt` can never fire without the caller explicitly passing its
 * own `wf.runKind` through.
 *
 * Throws {@link WorkflowBlockedIntake} directly for a `"block"` row that is
 * not bootstrap-exempted for this run (see this module's own doc comment for
 * why that, and not a return value, is the right shape) — the caller never
 * branches on the decision, it just calls this and, for a BLOCK agent on a
 * recurring run, never sees the line after it execute when context is
 * genuinely absent.
 *
 * Throws a plain `Error` if `agentId` has no row at all: a fifth agent
 * wired to this function without a policy decision is exactly the gap
 * `CONTEXT_DOC_POLICY`'s completeness is meant to close, and failing loudly
 * here is cheaper than silently defaulting to either BLOCK or DEGRADED for
 * an agent nobody actually decided on.
 */
export function enforceContextDocPolicy(params: {
  agentId: string;
  docs: Record<string, string | undefined>;
  runKind?: RunKind;
}): ContextDocPolicyOutcome {
  const row = CONTEXT_DOC_POLICY[params.agentId];
  if (!row) {
    throw new Error(
      `enforceContextDocPolicy: no CONTEXT_DOC_POLICY row for agent "${params.agentId}" — add one to CONTEXT_DOC_POLICY (packages/workflow/src/primitives/context-doc-policy.ts) before wiring this agent's grounding (SCRUM-242).`,
    );
  }

  const docTypes = Object.keys(params.docs);
  const missingDocTypes = docTypes.filter((docType) => params.docs[docType] === undefined);

  // "Missing required context" means EVERY doc this agent reads is absent —
  // see this module's own doc comment for why partial grounding (at least
  // one doc present) is not this ticket's failure mode.
  if (docTypes.length === 0 || missingDocTypes.length < docTypes.length) {
    return { decision: "ok" };
  }

  const reason = `${params.agentId}: missing required context doc(s) [${missingDocTypes.join(", ")}] — ${row.rationale}`;

  // SCRUM-388: bootstrap exemption. Only a "setup" run on a row explicitly
  // marked bootstrapExempt degrades instead of blocking — every recurring
  // run (and every non-exempt BLOCK row) throws exactly as before.
  const bootstrapExempted = row.decision === "block" && row.bootstrapExempt === true && params.runKind === "setup";

  if (row.decision === "block" && !bootstrapExempted) {
    throw new WorkflowBlockedIntake(reason);
  }

  return {
    decision: "degraded",
    marker: {
      contextGroundingStatus: "degraded",
      agentId: params.agentId,
      missingDocTypes,
      reason: bootstrapExempted
        ? `${reason} — exempted from BLOCK because this is a runKind:"setup" run producing these documents for the first time; report is degraded, not blocked`
        : reason,
    },
  };
}
