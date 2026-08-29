import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";
const SEGMENTS = ["client", "brand"] as const;

export const GetBrandInputSchema = z.object({});
export type GetBrandInput = z.infer<typeof GetBrandInputSchema>;

/** The tenant's brand kit. Loose shape — no canonical producer exists yet. */
export interface ClientBrand {
  voice?: string;
  colors?: string[];
  logoUrl?: string;
  tagline?: string;
  /**
   * SCRUM-309 (AU31). The language this client's content must be written
   * in — a plain name ("Hebrew", "Japanese") or a BCP-47-ish tag ("he",
   * "en-US"), whichever the portal captures; free text either way, on
   * purpose, since this field's whole job is to stop being free text
   * *elsewhere*. Before this field existed, the only way a language
   * requirement reached a drafting prompt was if `client.getProfile`'s
   * `description` happened to mention it in prose (e.g. "Israel's largest
   * Hebrew-language technology site") — a brand-voice document that stated
   * Hebrew nowhere near that blurb produced no signal at all, and the
   * geektime carousel shipped in fluent English and passed every check
   * (root cause 1 of that incident: no language dimension existed anywhere
   * in the QA chain). Consumed by `buildClientVoiceContext`
   * (`@agent-engine/workflow`), which every channel's copy-drafting step
   * threads into its prompt regardless of what profile/voice-rules prose
   * says. Optional so a client with no brand kit configured yet, or one
   * whose portal hasn't set this, still gets a run — same
   * refuse-to-guess-but-never-block posture as the rest of this file.
   */
  language?: string;
  [key: string]: unknown;
}

/**
 * Read-only lookup of the tenant's brand kit (RFC-01 §9.1/§9.2). Tenant comes
 * from `context.ctx.clientSlug` only — this tool takes no arguments.
 */
export function createGetBrand(store: WorkspaceStoreLike) {
  return defineTool<GetBrandInput, ClientBrand>({
    name: "client.getBrand",
    version: TOOL_VERSION,
    inputSchema: GetBrandInputSchema,
    async execute(_args, { ctx }) {
      const brand = await store.readJson<ClientBrand>(ctx.clientSlug, [...SEGMENTS]);
      if (!brand) {
        return notAvailable<ClientBrand>("brand kit has not been set up for this client yet");
      }
      return success(brand);
    },
  });
}
