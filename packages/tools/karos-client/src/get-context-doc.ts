import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/**
 * Where a client's projected context document lives:
 * `clients/<clientSlug>/context/<docType>.json` — C1 (SCRUM-209)'s path, not
 * `client.getKnowledge`'s `knowledge/context-docs.json` mirror, which is a
 * separate, older, portal-sync bundle of all doc types in one file. This is
 * the one-file-per-doc-type projection C1 defines; S-A14 is its writer.
 */
const SEGMENT = "context";

/**
 * C1's v1 set, and only these nine. `meeting-notes`, `client-guidelines` and
 * `action-plan` are deliberately excluded from v1 — do not add them here.
 */
export const CONTEXT_DOC_TYPES = [
  "brand-voice",
  "market-strategy",
  "competitor-analysis",
  "product-information",
  "branding-guidelines",
  "target-audience",
  "x",
  "linkedin",
  "reddit",
] as const;
export type ContextDocType = (typeof CONTEXT_DOC_TYPES)[number];

export const GetContextDocInputSchema = z.object({
  docType: z
    .enum(CONTEXT_DOC_TYPES)
    .describe(
      "Which projected context document to read: brand-voice, market-strategy, competitor-analysis, product-information, branding-guidelines, target-audience, or one of the three agent-profile docs (x, linkedin, reddit). C1's v1 set only — meeting-notes, client-guidelines and action-plan are not projected.",
    ),
});
export type GetContextDocInput = z.infer<typeof GetContextDocInputSchema>;

/**
 * Provenance for a projected context document (C1/SCRUM-209). Carried through
 * verbatim from whatever the projector wrote — this reader does not know who
 * wrote the projection and must not care, and in particular must never
 * recompute `contentHash` itself: it is C1's idempotency key, sha256 of
 * `markdown` alone, computed once by the writer over the bytes it wrote.
 */
export interface ClientContextDocSource {
  firestoreDocId: string;
  docVersion: number;
  tier: string;
  projectedAt: string;
  projectedBy: string;
  contentHash: string;
}

export interface ClientContextDoc {
  docType: ContextDocType;
  markdown: string;
  source: ClientContextDocSource;
}

/**
 * `client.getContextDoc` — one of a client's projected context documents
 * (C1/SCRUM-209), as dynamic run context.
 *
 * Until now, an agent's only view of a client's rich onboarding documents was
 * `clients.brandVoice`, one text field. C1 defines a projection that mirrors
 * each of nine document types into the workspace store as its own record, and
 * this tool is the read-only view over it — deliberately following the
 * `StrategyDocument` precedent (`client.getStrategy`) rather than inventing a
 * third schema: no tenant-shaped argument, `not_available` rather than a
 * throw when a document is missing, and the same double `not_available` for
 * an empty document.
 *
 * `not_available`, not an error, for a missing file *and* for a
 * present-but-empty `markdown`: an empty document is worse than a missing
 * one — it would silently hand the model no charter while looking
 * configured. The two cases carry different reasons on purpose, so an
 * operator fixing this can tell "nothing there" from "something there but
 * blank" without reading code.
 *
 * This is the reader only. The writer (S-A14, projecting from Firestore into
 * this same path) is Shlomi's; do not build it here.
 */
export function createGetContextDoc(store: WorkspaceStoreLike) {
  return defineTool<GetContextDocInput, ClientContextDoc>({
    name: "client.getContextDoc",
    description:
      "One of a client's projected context documents (brand-voice, market-strategy, competitor-analysis, product-information, branding-guidelines, target-audience, or the x/linkedin/reddit agent-profile docs), with full provenance so a run is attributable to a document version. Reports not_available (not an error) when the document is missing or its markdown is empty.",
    version: TOOL_VERSION,
    inputSchema: GetContextDocInputSchema,
    async execute({ docType }, { ctx }) {
      const doc = await store.readJson<{
        markdown?: unknown;
        source?: ClientContextDocSource;
      }>(ctx.clientSlug, [SEGMENT, docType]);

      if (!doc) {
        return notAvailable<ClientContextDoc>(
          `no ${docType} context document for client "${ctx.clientSlug}" — expected clients/${ctx.clientSlug}/${SEGMENT}/${docType}.json`,
        );
      }
      if (typeof doc.markdown !== "string" || doc.markdown.trim().length === 0) {
        // Same reasoning as client.getStrategy: an empty document is worse
        // than a missing one, so it gets its own not_available rather than
        // succeeding with a blank charter.
        return notAvailable<ClientContextDoc>(
          `the ${docType} context document for client "${ctx.clientSlug}" has no "markdown" content`,
        );
      }

      return success<ClientContextDoc>({
        docType,
        markdown: doc.markdown,
        source: doc.source as ClientContextDocSource,
      });
    },
  });
}
