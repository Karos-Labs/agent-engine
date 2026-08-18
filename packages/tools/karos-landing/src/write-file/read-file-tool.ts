import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool, success, notAvailable } from "@agent-engine/tool-common";
import type { LandingEngineConfig } from "../config.js";
import { assertReadPathWithinRoot, siteRootForClient } from "../sandbox/site-sandbox.js";

const TOOL_VERSION = "1.0.0";

export const ReadSiteFileInputSchema = z.object({
  relativePath: z.string().min(1),
});
export type ReadSiteFileInput = z.infer<typeof ReadSiteFileInputSchema>;

export interface ReadSiteFileResult {
  content: string;
}

/**
 * `landing.readSiteFile` — the read-side counterpart `MODE=rebuild` needs to
 * load the durable build state (`brand.json` / `src/content/<slug>.ts` /
 * `page.tsx`, FEEDBACK.md §1) back out of a client's own site directory
 * before applying a feedback delta. Same sandbox boundary as the write tool,
 * without the symlink/realpath machinery (nothing is created by a read).
 */
export function createReadSiteFile(config: LandingEngineConfig) {
  return defineTool<ReadSiteFileInput, ReadSiteFileResult>({
    name: "landing.readSiteFile",
    version: TOOL_VERSION,
    inputSchema: ReadSiteFileInputSchema,
    async execute({ relativePath }, { ctx }) {
      const siteRoot = siteRootForClient(config, ctx.clientSlug);
      const target = assertReadPathWithinRoot(siteRoot, relativePath, "relativePath");
      try {
        const content = await fs.readFile(target, "utf8");
        return success<ReadSiteFileResult>({ content });
      } catch (err) {
        if (isNotFound(err)) return notAvailable(`"${relativePath}" does not exist under this client's site yet`);
        throw err;
      }
    },
  });
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT";
}
