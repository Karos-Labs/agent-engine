import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const GetKnowledgeInputSchema = z.object({});
export type GetKnowledgeInput = z.infer<typeof GetKnowledgeInputSchema>;

/**
 * One onboarding/context document, as karosCMO's knowledge sync mirrors it
 * (`karosCMO/src/lib/agent-engine/knowledge-sync.ts` — the producer of every
 * file this tool reads, and the place the tier rules and content caps live).
 */
export interface KnowledgeContextDoc {
  docType: string;
  tier: string;
  version: number;
  content: string;
}

export interface KnowledgeTranscript {
  title: string;
  meetingDate?: number;
  summary?: string;
  actionItems?: string[];
}

export interface KnowledgeAssetIndexEntry {
  name: string;
  mimeType: string;
  note?: string;
  purpose?: string;
  url: string;
}

export interface ClientKnowledge {
  contextDocs: KnowledgeContextDoc[];
  transcripts: KnowledgeTranscript[];
  assets: KnowledgeAssetIndexEntry[];
}

/**
 * Read-only lookup of the client knowledge base the portal mirrors into this
 * workspace: onboarding/context documents, recent meeting summaries, and the
 * uploaded-reference-asset index.
 *
 * THREE FIXED READS, never a directory listing: the layout is deliberately
 * flat (`knowledge/context-docs.json`, `knowledge/transcripts.json`,
 * `knowledge/assets.json`) because `WorkspaceStoreLike.listJson`'s recursion
 * semantics diverge between the GCS and local-file backends — a deterministic
 * GET per file behaves identically on both. Each read is independent and
 * best-effort; `not_available` only when none of the three exist, so a client
 * whose sync has never run degrades exactly like one with no intel report.
 */
export function createGetKnowledge(store: WorkspaceStoreLike) {
  return defineTool<GetKnowledgeInput, ClientKnowledge>({
    name: "client.getKnowledge",
    description:
      "Read-only lookup of the client knowledge base the portal mirrors into this workspace: onboarding/context documents, recent meeting summaries, and the uploaded-reference-asset index. Tenant comes from context only — this tool takes no arguments.",
    version: TOOL_VERSION,
    inputSchema: GetKnowledgeInputSchema,
    async execute(_args, { ctx }) {
      const [docsFile, transcriptsFile, assetsFile] = await Promise.all([
        store.readJson<{ docs?: KnowledgeContextDoc[] }>(ctx.clientSlug, ["knowledge", "context-docs"]),
        store.readJson<{ transcripts?: KnowledgeTranscript[] }>(ctx.clientSlug, ["knowledge", "transcripts"]),
        store.readJson<{ assets?: KnowledgeAssetIndexEntry[] }>(ctx.clientSlug, ["knowledge", "assets"]),
      ]);
      if (!docsFile && !transcriptsFile && !assetsFile) {
        return notAvailable<ClientKnowledge>("no knowledge base has been synced for this client yet");
      }
      return success<ClientKnowledge>({
        contextDocs: Array.isArray(docsFile?.docs) ? docsFile.docs : [],
        transcripts: Array.isArray(transcriptsFile?.transcripts) ? transcriptsFile.transcripts : [],
        assets: Array.isArray(assetsFile?.assets) ? assetsFile.assets : [],
      });
    },
  });
}
