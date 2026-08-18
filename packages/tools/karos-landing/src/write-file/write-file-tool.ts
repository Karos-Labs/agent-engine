import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success } from "@agent-engine/tool-common";
import type { LandingEngineConfig } from "../config.js";
import { resolveSandboxedWritePath, siteRootForClient } from "../sandbox/site-sandbox.js";

const TOOL_VERSION = "1.0.0";

export const WriteSiteFileInputSchema = z.object({
  /** Relative to `OUTPUT_PATH/site` (e.g. `src/app/globals.css`, `src/content/forge.ts`). Never absolute, never containing `..` — enforced by the sandbox, not by convention. */
  relativePath: z.string().min(1),
  content: z.string(),
});
export type WriteSiteFileInput = z.infer<typeof WriteSiteFileInputSchema>;

export interface WriteSiteFileResult {
  path: string;
  bytesWritten: number;
}

/**
 * `landing.writeSiteFile` (RFC-07 §4 phase 4 / §7): the scoped file-write
 * tool phase 4 (MAKE) uses to re-skin tokens/fonts, write the content file,
 * and compose bespoke/carry-forward components. Bounded structurally to one
 * client's `OUTPUT_PATH/site` — `clientSlug` comes only from `ctx`, never
 * from the tool's own arguments (RFC-01 §9.1 rule 1), and every
 * `relativePath` is resolved through `resolveSandboxedWritePath`, which
 * throws `SiteSandboxViolation` (surfaced by `defineTool` as `tooling_error`,
 * never a silent no-op or a content judgment) on path traversal, an absolute
 * path, a symlink escape, or a target that lands inside the read-only
 * template root. Requires the site to already exist — call
 * `landing.copyTemplate` first.
 */
export function createWriteSiteFile(config: LandingEngineConfig) {
  return defineTool<WriteSiteFileInput, WriteSiteFileResult>({
    name: "landing.writeSiteFile",
    version: TOOL_VERSION,
    inputSchema: WriteSiteFileInputSchema,
    async execute({ relativePath, content }, { ctx }) {
      const siteRoot = siteRootForClient(config, ctx.clientSlug);
      const target = await resolveSandboxedWritePath(siteRoot, config.templateRoot, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
      return success<WriteSiteFileResult>({ path: target, bytesWritten: Buffer.byteLength(content, "utf8") });
    },
  });
}
