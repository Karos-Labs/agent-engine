import type { AgentToolRegistry } from "@agent-engine/core";
import { WorkflowBlockedIntake, WorkflowToolingFailure, type WorkflowContext } from "@agent-engine/workflow";
import {
  LinkedInSetupInputSchema,
  slugifySeat,
  type LinkedInSeatIntake,
  type SetupWorkflowResult,
} from "./types.js";

export interface CreateLinkedInSetupWorkflowOptions {
  tools: AgentToolRegistry;
}

/**
 * LinkedIn onboarding: turn filled intake forms into the charters the drafting
 * agent reads.
 *
 * ## Why this is code and not a model
 *
 * No `step.agent` anywhere. A setup run's job is to record what a person
 * said, and a model in that path can only paraphrase it — which for a document
 * whose whole purpose is "never post about X" is a way to lose the X. The
 * lab-repo originals are filled forms, and so is this.
 *
 * ## Where it writes
 *
 * `clients/<slug>/strategy/linkedin-agent/<seat>.json`, keyed by the seat's
 * kebab-cased name, which is exactly what the lab-repo migration produced and
 * what `linkedin-agent` looks up when it posts as an executive. The company
 * page writes the agent-level document, because that is what the drafting
 * agent falls back to for a company-scope run.
 *
 * ## One seat failing does not fail the run
 *
 * Six seats submitted and one malformed should store five, not zero. Each is
 * its own checkpointed step, and the skipped ones come back named — a run that
 * silently stored four of five is how someone discovers a missing charter at
 * draft time.
 */
export function createLinkedInSetupWorkflow(options: CreateLinkedInSetupWorkflowOptions) {
  const tools = options.tools;

  return async function linkedInSetupWorkflow(wf: WorkflowContext): Promise<SetupWorkflowResult> {
    const ctx = {
      runId: wf.runId,
      clientSlug: wf.clientSlug,
      productId: wf.productId,
      runKind: wf.runKind,
      metadata: {},
    };

    // ── 00: intake — the form submission IS the run's input ──
    const intake = await wf.step.code("00-parse-intake", (): ReturnType<typeof parse> => parse(wf.input));

    if (intake.seats.length === 0 && !intake.companyUpdates) {
      // Nothing to record is not a failure of the engine; it is a form nobody
      // filled in, and the person who dispatched it needs to hear that.
      throw new WorkflowBlockedIntake(
        "linkedin setup received no seats and no company direction — nothing to record",
      );
    }

    const save = tools["intake.saveStrategy"];
    if (!save) {
      throw new WorkflowToolingFailure(
        "intake.saveStrategy is not registered — a setup agent cannot write without it",
      );
    }

    const written: string[] = [];
    const skipped: SetupWorkflowResult["skipped"] = [];

    // ── 01: the company page's standing direction ──
    if (intake.companyUpdates?.trim()) {
      const outcome = await wf.step.code("01-save-company-direction", async () =>
        save.execute(
          {
            agent: "linkedin-agent",
            markdown: renderCompanyDoc(wf.clientSlug, intake.companyUpdates!),
            source: { form: "linkedin-setup", runId: wf.runId },
          },
          { ctx },
        ),
      );
      if (outcome.status === "success") written.push("strategy/linkedin-agent");
      else skipped.push({ key: "company", reason: describe(outcome) });
    }

    // ── 02+: one document per seat ──
    for (const [index, seat] of intake.seats.entries()) {
      const key = slugifySeat(seat.fullName);
      if (!key) {
        // The name becomes a path segment; one that slugifies to nothing would
        // write to the agent-level document and overwrite the company page.
        skipped.push({ key: seat.fullName, reason: "name does not produce a usable key" });
        continue;
      }

      const outcome = await wf.step.code(`02-save-seat-${index + 1}`, async () =>
        save.execute(
          {
            agent: "linkedin-agent",
            key,
            markdown: renderSeatDoc(seat),
            source: { form: "linkedin-setup", runId: wf.runId, seat: key },
          },
          { ctx },
        ),
      );
      if (outcome.status === "success") written.push(`strategy/linkedin-agent/${key}`);
      else skipped.push({ key, reason: describe(outcome) });
    }

    if (written.length === 0) {
      throw new WorkflowToolingFailure(
        `linkedin setup stored nothing: ${skipped.map((s) => `${s.key} (${s.reason})`).join("; ")}`,
      );
    }

    return { written, skipped };
  };
}

function parse(input: Readonly<Record<string, unknown>>) {
  const parsed = LinkedInSetupInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkflowBlockedIntake(`linkedin setup payload is not valid: ${parsed.error.message}`);
  }
  return parsed.data;
}

function describe(outcome: { status: string; reason?: string }): string {
  return "reason" in outcome && outcome.reason ? `${outcome.status}: ${outcome.reason}` : outcome.status;
}

/**
 * The seat charter, in the shape a drafting run expects to read.
 *
 * Markdown rather than JSON fields because that is what reaches the model:
 * `client.getStrategy` hands the whole document to the prompt, and a heading a
 * person wrote reads better there than a serialized object.
 */
function renderSeatDoc(seat: LinkedInSeatIntake): string {
  const lines = [
    `# LinkedIn seat — ${seat.fullName}`,
    "",
    "> Recorded by the LinkedIn setup agent from a filled portal form.",
    "",
  ];
  if (seat.role) lines.push(`**Role.** ${seat.role}`, "");
  if (seat.profileUrl) lines.push(`**Profile.** ${seat.profileUrl}`, "");
  if (seat.focusTopics.length > 0) {
    lines.push("**Known for.**", ...seat.focusTopics.map((t) => `- ${t}`), "");
  }
  if (seat.offLimitsTopics.length > 0) {
    // Kept as its own heading, and last-but-one, because this is the half a
    // drafting run has to honour rather than draw on.
    lines.push("**Never post.**", ...seat.offLimitsTopics.map((t) => `- ${t}`), "");
  }
  if (seat.voiceSample) {
    lines.push("**Voice sample.**", "", seat.voiceSample.trim(), "");
  }
  if (seat.cvPath) lines.push(`**CV on file.** ${seat.cvPath}`, "");
  return lines.join("\n");
}

function renderCompanyDoc(clientSlug: string, direction: string): string {
  return [
    `# LinkedIn company page — ${clientSlug}`,
    "",
    "> Standing direction for the company page, recorded by the LinkedIn setup agent.",
    "",
    direction.trim(),
    "",
  ].join("\n");
}
