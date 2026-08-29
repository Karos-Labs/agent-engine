import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import type { LandingEngineConfig } from "../config.js";
import { resolveSandboxedWritePath, siteRootForClient } from "../sandbox/site-sandbox.js";

const TOOL_VERSION = "1.0.0";

export const WriteSiteFileInputSchema = z.object({
  /** Relative to `OUTPUT_PATH/site` (e.g. `src/app/globals.css`, `src/content/forge.ts`). Never absolute, never containing `..` — enforced by the sandbox, not by convention. */
  relativePath: z.string().min(1).describe("Path, relative to OUTPUT_PATH/site (e.g. \"src/app/globals.css\", \"src/content/forge.ts\"), of the file to write. Never absolute, never containing \"..\" — enforced by the sandbox, not by convention."),
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage.
  content: z.string().describe("The file's full contents to write, as UTF-8 text."),
});
export type WriteSiteFileInput = z.infer<typeof WriteSiteFileInputSchema>;

export interface WriteSiteFileResult {
  path: string;
  bytesWritten: number;
}

/**
 * Build/package configuration whose *content*, not just its location, is
 * security-relevant: `next build` (`landing.gate`'s `doBuild`) executes
 * `next.config.*` and any `package.json` script as real code at build time,
 * so the sandbox's path-containment guarantee alone does not stop a
 * model-authored file here from achieving code execution on the host. These
 * files come from the trusted template kit only (`landing.copyTemplate`,
 * which does not go through this tool) — MAKE-phase edits are limited to CSS
 * tokens, fonts, the content file, and bespoke/carry-forward components
 * (RFC-07 §4 phase 4), never build configuration.
 */
const PROTECTED_CONFIG_BASENAME_PATTERNS: readonly RegExp[] = [
  /^next\.config\.(mjs|cjs|js|ts)$/i,
  /^package(-lock)?\.json$/i,
  /^tsconfig(\.[\w.-]+)?\.json$/i,
  /^\.npmrc$/i,
  /^\.env(\.[\w.-]+)?$/i,
];

function isProtectedConfigFile(relativePath: string): boolean {
  const basename = path.basename(relativePath.replace(/\\/g, "/"));
  return PROTECTED_CONFIG_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
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
 * template root. Also refuses (`tooling_error`) any target whose *filename*
 * is build/package configuration (`next.config.*`, `package(-lock).json`,
 * `tsconfig*.json`, `.npmrc`, `.env*`) — those are never MAKE-phase edits,
 * and `landing.gate`'s `doBuild` executes them as real code, so a
 * model-authored one is a code-execution vector the path fence alone does
 * not stop. Requires the site to already exist — call `landing.copyTemplate`
 * first.
 */
export function createWriteSiteFile(config: LandingEngineConfig) {
  return defineTool<WriteSiteFileInput, WriteSiteFileResult>({
    name: "landing.writeSiteFile",
    description:
      "The scoped file-write tool the MAKE phase uses to re-skin tokens/fonts, write the content file, and compose bespoke/carry-forward components. Bounded structurally to one client's OUTPUT_PATH/site; refuses to touch build/package configuration files (next.config.*, package(-lock).json, tsconfig*.json, .npmrc, .env*), since those execute as real code at build time. Requires the site to already exist — call landing.copyTemplate first.",
    version: TOOL_VERSION,
    inputSchema: WriteSiteFileInputSchema,
    async execute({ relativePath, content }, { ctx }) {
      if (isProtectedConfigFile(relativePath)) {
        return toolingError(
          `writing to "${relativePath}" is not permitted — build/package configuration is locked and may only come from the template kit`,
        );
      }
      const siteRoot = siteRootForClient(config, ctx.clientSlug);
      const target = await resolveSandboxedWritePath(siteRoot, config.templateRoot, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
      return success<WriteSiteFileResult>({ path: target, bytesWritten: Buffer.byteLength(content, "utf8") });
    },
  });
}
