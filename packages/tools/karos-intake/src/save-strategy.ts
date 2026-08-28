import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { contentFail, defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/**
 * Where a setup run puts what it collected.
 *
 * The same path `client.getStrategy` reads, deliberately: an onboarding run and
 * the drafting run that follows it have to agree on where a client's charter
 * lives, and the way to guarantee that is one constant rather than two string
 * literals that happen to match today.
 */
const SEGMENT = "strategy";

export const SaveStrategyInputSchema = z.object({
  agent: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "agent must be lowercase-and-hyphens")
    .describe("Which agent this document configures, e.g. \"linkedin-agent\"."),
  key: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "key must be lowercase-and-hyphens")
    .optional()
    .describe(
      "The sub-document — a seat, an account, a config. Omitted writes the agent-level document. Charset-restricted because it becomes a path segment: a key containing a slash would write outside the agent's own folder.",
    ),
  markdown: z.string().min(1).describe("The document itself, as markdown."),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "The same charter as machine-readable fields, for the parts of it a code step has to act on rather than read (e.g. a subreddit allowlist a check compares against). A second view of markdown, never a replacement — both are written together and neither is derived at read time.",
    ),
  source: z.record(z.string(), z.unknown()).optional().describe("Where it came from — a form submission, a lab-repo path, a human."),
});
export type SaveStrategyInput = z.infer<typeof SaveStrategyInputSchema>;

/**
 * `intake.saveStrategy` — writes a client's setup document.
 *
 * Deliberately NOT part of `karos-client`. Every tool in that package is a
 * read-only view of a tenant's onboarding data, and its own doc comment says
 * so; adding the first write there would make "client.*" mean two things and
 * quietly give every agent that already has the bundle a way to rewrite a
 * client's charter. Setup agents get this tool; drafting agents do not.
 *
 * Tenant comes from `ctx.clientSlug`, never from an argument, for the same
 * reason the read side does: an agent running for one client must not be able
 * to name another.
 */
export function createSaveStrategy(store: WorkspaceStoreLike) {
  return defineTool<SaveStrategyInput, IdempotentWriteResult>({
    name: "intake.saveStrategy",
    description:
      "Writes a client's setup document (a charter: what an account should post, what it must never post, which accounts it engages). Idempotent per (agent, key) path; refuses to write an empty document.",
    version: TOOL_VERSION,
    inputSchema: SaveStrategyInputSchema,
    async execute({ agent, key, markdown, data, source }, { ctx }) {
      const body = markdown.trim();
      if (body.length === 0) {
        // An empty charter is worse than no charter: it reads as configured
        // while telling the drafting agent nothing.
        return contentFail<IdempotentWriteResult>(
          `intake.saveStrategy: refusing to write an empty ${agent} document for "${ctx.clientSlug}"`,
        );
      }

      const segments = key ? [SEGMENT, agent, key] : [SEGMENT, agent];
      const { created } = await store.writeJson(ctx.clientSlug, segments, {
        markdown: body,
        ...(data ? { data } : {}),
        // Provenance travels with the document, matching what the lab-repo
        // migration records, so a reader can tell a form submission from an
        // imported file months later.
        source: { producedBy: "intake.saveStrategy", ...(source ?? {}) },
      });

      return success<IdempotentWriteResult>({ id: segments.join("/"), created });
    },
  });
}
