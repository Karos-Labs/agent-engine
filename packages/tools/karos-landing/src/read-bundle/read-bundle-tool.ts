import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail } from "@agent-engine/tool-common";
import type { LandingEngineConfig } from "../config.js";
import { BrandJsonSchema, type BrandJson } from "../types.js";

const TOOL_VERSION = "1.0.0";

export const ReadBundleInputSchema = z.object({});
export type ReadBundleInput = z.infer<typeof ReadBundleInputSchema>;

export interface ReadBundleResult {
  brand: BrandJson;
  intakeMarkdown: string;
  /** Repo-relative paths of client-supplied media found under `<bundle>/assets/` (option A media, AGENT-INVOCATION.md §6). */
  assetPaths: string[];
  /** Repo-relative paths of the captured old-site screenshots/DOM under `<bundle>/oldSite/`, if any. */
  oldSiteCapturePaths: string[];
  /** Raw (unvalidated) `feedback-round.json` files found under `<bundle>/feedback/` (FEEDBACK.md §2/§5) — `MODE=rebuild` reads these. Parsing/validating against the round schema is the workflow's job (that schema is agent-package-owned, not this tool package's); a file that isn't valid JSON is skipped rather than failing the whole bundle read. */
  feedbackRounds: Array<{ file: string; data: unknown }>;
}

async function listFilesRecursive(root: string, dir: string = root): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const acc: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Relative to `root`, not `dir` — otherwise a nested file's returned path would be relative
      // to its immediate parent only, dropping every intermediate subdirectory segment.
      acc.push(...(await listFilesRecursive(root, abs)));
    } else if (entry.isFile()) {
      acc.push(path.relative(root, abs));
    }
  }
  return acc;
}

/**
 * `landing.readBundle` (RFC-07 §4 phase 0 INTAKE / AGENT-INVOCATION.md §1):
 * reads one client's assembled input bundle — `brand.json` (required),
 * `intake.md` (required), `assets/` and `oldSite/` (both optional, listed
 * only). `bundlesRoot` is bound at tool construction, `clientSlug` comes
 * only from `ctx` — the bundle path is never a model-supplied argument, the
 * same tenant-is-structural rule every other tool in this repo follows.
 * A missing/malformed `brand.json` or `intake.md` is a `content_fail`
 * (real, actionable intake-data signal, per RFC-01 §6), never a
 * `tooling_error` — the bundle genuinely isn't ready, which is exactly the
 * `blocked_intake` condition the workflow's step 00 checks for.
 */
export function createReadBundle(config: LandingEngineConfig) {
  return defineTool<ReadBundleInput, ReadBundleResult>({
    name: "landing.readBundle",
    version: TOOL_VERSION,
    inputSchema: ReadBundleInputSchema,
    async execute(_input, { ctx }) {
      const bundleRoot = path.join(config.bundlesRoot, ctx.clientSlug);

      let brandRaw: string;
      try {
        brandRaw = await fs.readFile(path.join(bundleRoot, "brand.json"), "utf8");
      } catch {
        return contentFail<ReadBundleResult>(`no brand.json found in the input bundle at "${bundleRoot}"`);
      }
      let brandParsed: unknown;
      try {
        brandParsed = JSON.parse(brandRaw);
      } catch (err) {
        return contentFail<ReadBundleResult>(`brand.json in "${bundleRoot}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      const brand = BrandJsonSchema.safeParse(brandParsed);
      if (!brand.success) {
        return contentFail<ReadBundleResult>(`brand.json in "${bundleRoot}" does not match the brand contract: ${brand.error.message}`);
      }

      let intakeMarkdown: string;
      try {
        intakeMarkdown = await fs.readFile(path.join(bundleRoot, "intake.md"), "utf8");
      } catch {
        return contentFail<ReadBundleResult>(`no intake.md found in the input bundle at "${bundleRoot}"`);
      }

      const assetPaths = await listFilesRecursive(path.join(bundleRoot, "assets"));
      const oldSiteCapturePaths = await listFilesRecursive(path.join(bundleRoot, "oldSite"));

      const feedbackDir = path.join(bundleRoot, "feedback");
      const feedbackFiles = (await listFilesRecursive(feedbackDir)).filter((f) => f.endsWith(".json"));
      const feedbackRounds: Array<{ file: string; data: unknown }> = [];
      for (const file of feedbackFiles) {
        try {
          feedbackRounds.push({ file, data: JSON.parse(await fs.readFile(path.join(feedbackDir, file), "utf8")) });
        } catch {
          // Not valid JSON — skipped rather than failing the whole bundle read; the workflow's
          // own FeedbackRoundSchema validation is where a genuinely malformed round surfaces.
        }
      }

      return success<ReadBundleResult>({ brand: brand.data, intakeMarkdown, assetPaths, oldSiteCapturePaths, feedbackRounds });
    },
  });
}
