import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail } from "@agent-engine/tool-common";
import type { LandingEngineConfig } from "../config.js";
import { resolveSandboxedWritePath, siteRootForClient } from "../sandbox/site-sandbox.js";

const TOOL_VERSION = "1.0.0";

/** Directories never copied out of the template kit — build artifacts and VCS metadata, never part of the floor. */
const SKIP_DIR_NAMES = new Set(["node_modules", ".next", ".git", "dist"]);

export const CopyTemplateInputSchema = z.object({
  /** Re-copy over an existing site directory for this client. Default false so a `MODE=rebuild` run (which must NOT recopy the template — FEEDBACK.md §4 step 4) can never accidentally clobber a client's built state by calling this tool again. */
  force: z.boolean().default(false),
});
export type CopyTemplateInput = z.infer<typeof CopyTemplateInputSchema>;

export interface CopyTemplateResult {
  siteRoot: string;
  filesCopied: number;
}

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * `landing.copyTemplate` (RFC-07 §4 phase 4 / §7): the one tool allowed to
 * *create* `OUTPUT_PATH/site` — every other write tool in this package
 * requires the site root to already exist (`resolveSandboxedWritePath`
 * throws otherwise), by design, so a stray write call can never silently
 * originate a new client directory tree. Copies `TEMPLATE_PATH` byte-for-byte
 * (never reads it as text, so binary assets under the template survive
 * unchanged); the read side of this operation is unrestricted (the template
 * is the trusted source), only the write side is sandboxed.
 */
export function createCopyTemplate(config: LandingEngineConfig) {
  return defineTool<CopyTemplateInput, CopyTemplateResult>({
    name: "landing.copyTemplate",
    version: TOOL_VERSION,
    inputSchema: CopyTemplateInputSchema,
    async execute({ force }, { ctx }) {
      const siteRoot = siteRootForClient(config, ctx.clientSlug);

      if (await pathExists(siteRoot)) {
        if (!force) {
          return contentFail<CopyTemplateResult>(
            `"${siteRoot}" already exists — pass force:true to overwrite, or use MODE=rebuild instead of re-copying the template`,
          );
        }
        await fs.rm(siteRoot, { recursive: true, force: true });
      }

      await fs.mkdir(siteRoot, { recursive: true });

      const templateFiles = await walk(config.templateRoot);
      let filesCopied = 0;
      for (const absSource of templateFiles) {
        const relPath = path.relative(config.templateRoot, absSource);
        const target = await resolveSandboxedWritePath(siteRoot, config.templateRoot, relPath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(absSource, target);
        filesCopied++;
      }

      return success<CopyTemplateResult>({ siteRoot, filesCopied });
    },
  });
}
