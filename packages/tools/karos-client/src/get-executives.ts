import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";
const SEGMENTS = ["client", "executives"] as const;

export const GetExecutivesInputSchema = z.object({});
export type GetExecutivesInput = z.infer<typeof GetExecutivesInputSchema>;

/**
 * A single tracked executive. Mirrors the fields
 * `products/live/linkedin-agent/references/founder-persona-spec.md` mines
 * out of a CV into a per-exec persona file (`assets/persona-template.md`) —
 * restored in Phase 2.5 Batch 2.2 so `identityScope: "executive"` runs can
 * carry a real founder dossier, not just a name and a title. Still no
 * canonical producer/onboarding UI exists that writes these richer fields
 * yet; a client with only `name`/`title` configured remains perfectly valid
 * (every added field below is optional) — this just gives a client that
 * *has* done the CV-mining work somewhere to put the result.
 */
export interface Executive {
  name: string;
  title?: string;
  /**
   * The mined-CV "lens" narrative (spec §2): what each prior company
   * actually did, this executive's role there, and the earned point of view
   * it gives them, ending in the career's single throughline. Free text —
   * the value is the prose a model can draw credibility and stories from,
   * not a structured record.
   */
  careerHistory?: string;
  /** The 3-5 earned pillars (spec §3) — topics this executive can post on with authority because of `careerHistory`. Ongoing posts draw only from these. */
  corePillars?: string[];
  /** Topics that would read as borrowed credibility for this executive (spec §3) — the earned-claim gate's hard "do not post" list, not just a style preference. */
  offLimitsTopics?: string[];
  /** This executive's own sampled voice/tone (spec §4) — deliberately distinct from the company's own `voiceRules.tone`; a founder's post is not the company's press release wearing a first-person disguise. */
  voiceTone?: string;
  [key: string]: unknown;
}

/**
 * Read-only lookup of the tenant's executive list (RFC-01 §9.1/§9.2), stored
 * as a single JSON array file. Tenant comes from `context.ctx.clientSlug`
 * only — this tool takes no arguments.
 *
 * An existing-but-empty array is a normal `success` with an empty list — only
 * a genuinely missing file is `not_available`.
 */
export function createGetExecutives(store: WorkspaceStoreLike) {
  return defineTool<GetExecutivesInput, Executive[]>({
    name: "client.getExecutives",
    version: TOOL_VERSION,
    inputSchema: GetExecutivesInputSchema,
    async execute(_args, { ctx }) {
      const executives = await store.readJson<Executive[]>(ctx.clientSlug, [...SEGMENTS]);
      if (!executives) {
        return notAvailable<Executive[]>("executive list has not been set up for this client yet");
      }
      return success(executives);
    },
  });
}
