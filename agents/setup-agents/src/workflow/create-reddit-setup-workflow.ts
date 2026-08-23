import type { AgentToolRegistry } from "@agent-engine/core";
import { WorkflowBlockedIntake, WorkflowToolingFailure, type WorkflowContext } from "@agent-engine/workflow";
import {
  RedditSetupInputSchema,
  normalizeSubreddit,
  type RedditSetupInput,
  type SetupWorkflowResult,
} from "./types.js";

export interface CreateRedditSetupWorkflowOptions {
  tools: AgentToolRegistry;
}

/**
 * Reddit onboarding: record which communities this client may post into, and
 * how.
 *
 * Writes `clients/<slug>/strategy/reddit-agent/config.json` — a keyed document
 * rather than the agent-level one, matching the path the drafting agent's own
 * lookup uses and leaving the agent-level slot free for the account voice the
 * lab-repo migration puts there.
 *
 * Code, not a model, for the same reason as the LinkedIn side: a setup run
 * records what a person said, and paraphrasing a "never engage on X" list is
 * how the X goes missing.
 *
 * Reddit is draft-only as a hard product rule and nothing here changes that.
 * This records where a human may later post from their own account; it grants
 * no posting capability, and none exists to grant.
 */
export function createRedditSetupWorkflow(options: CreateRedditSetupWorkflowOptions) {
  const tools = options.tools;

  return async function redditSetupWorkflow(wf: WorkflowContext): Promise<SetupWorkflowResult> {
    const ctx = {
      runId: wf.runId,
      clientSlug: wf.clientSlug,
      productId: wf.productId,
      runKind: wf.runKind,
      metadata: {},
    };

    const intake = await wf.step.code("00-parse-intake", () => {
      const parsed = RedditSetupInputSchema.safeParse(wf.input);
      if (!parsed.success) {
        throw new WorkflowBlockedIntake(`reddit setup payload is not valid: ${parsed.error.message}`);
      }
      // Normalised here rather than at read time so the stored document is the
      // canonical form and every later reader sees the same strings.
      const subreddits = [...new Set(parsed.data.targetSubreddits.map(normalizeSubreddit).filter(Boolean))];
      if (subreddits.length === 0) {
        throw new WorkflowBlockedIntake("reddit setup received no usable subreddit names");
      }
      return { ...parsed.data, targetSubreddits: subreddits };
    });

    const save = tools["intake.saveStrategy"];
    if (!save) {
      throw new WorkflowToolingFailure(
        "intake.saveStrategy is not registered — a setup agent cannot write without it",
      );
    }

    const outcome = await wf.step.code("01-save-reddit-config", async () =>
      save.execute(
        {
          agent: "reddit-agent",
          key: "config",
          markdown: renderConfigDoc(wf.clientSlug, intake),
          source: { form: "reddit-setup", runId: wf.runId },
        },
        { ctx },
      ),
    );

    if (outcome.status !== "success") {
      throw new WorkflowToolingFailure(
        `reddit setup could not store its config: ${outcome.status}${
          "reason" in outcome && outcome.reason ? ` — ${outcome.reason}` : ""
        }`,
      );
    }

    return { written: ["strategy/reddit-agent/config"], skipped: [] };
  };
}

// Takes the schema's own inferred type rather than restating its shape: under
// exactOptionalPropertyTypes a hand-written `accountName?: string` is not the
// same type as one that may be explicitly undefined, and restating it is how
// the two drift.
function renderConfigDoc(clientSlug: string, intake: RedditSetupInput): string {
  const lines = [
    `# Reddit setup — ${clientSlug}`,
    "",
    "> Recorded by the Reddit setup agent from a filled portal form.",
    "> Draft-only: one run drafts ONE reply, and a human posts it from their own account.",
    "",
    "**Communities.**",
    ...intake.targetSubreddits.map((s) => `- ${s}`),
    "",
  ];
  if (intake.accountName) lines.push(`**Account.** ${intake.accountName}`, "");
  if (intake.voiceNotes) lines.push("**Voice.**", "", intake.voiceNotes.trim(), "");
  if (intake.offLimitsTopics.length > 0) {
    lines.push("**Never engage on.**", ...intake.offLimitsTopics.map((t) => `- ${t}`), "");
  }
  return lines.join("\n");
}
