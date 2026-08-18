import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, parseDurationMs, success } from "@agent-engine/tool-common";
import { latestRun, runSegments, type RunRecord } from "./runs.js";

const TOOL_VERSION = "1.0.0";

/** The 5 fixed AI-visibility engines (RFC-04 Phase 3 — `seo-geo-capture-config.json` `engines[]`). */
export const VISIBILITY_ENGINES = ["chatgpt", "perplexity", "gemini", "claude", "copilot"] as const;
export type VisibilityEngine = (typeof VISIBILITY_ENGINES)[number];

export const CAPTURE_TIERS = ["MEASURED", "MEASURED_grounded", "ESTIMATED", "UNAVAILABLE"] as const;
export type CaptureTier = (typeof CAPTURE_TIERS)[number];

export const CaptureVisibilityInputSchema = z.object({
  promptId: z.string().min(1),
  promptText: z.string().min(1),
  engine: z.enum(VISIBILITY_ENGINES),
  clientDomains: z.array(z.string()).min(1),
  competitorRoster: z.array(z.string()).default([]),
  /** Freshness window, same convention as `research.pull` — a cached cell inside this window is returned instead of re-capturing. */
  window: z.string().min(1),
});
export type CaptureVisibilityInput = z.infer<typeof CaptureVisibilityInputSchema>;

/** The (prompt × engine) capture cell shape — the load-bearing subset of `seo-geo-capture-config.json`'s `response_set.per_prompt_engine_fields` (~29 fields); mirrors `@agent-engine/tool-karos-seo-geo`'s `CaptureCell` without a cross-package dependency (RFC-01 §4: tool packages stay independent; the workflow layer wires them together). */
export interface CaptureCell {
  promptId: string;
  engine: VisibilityEngine;
  captureTier: CaptureTier;
  brandMentioned: boolean;
  brandFirstMentionCharOffset?: number;
  brandCited: boolean;
  brandFirstCitationOrdinal?: number;
  /** Competitor roster members named in this answer, each with the char offset of their first mention — required to determine who was named first, not just whether a competitor appeared at all. */
  competitorsNamed: Array<{ brandId: string; charOffset: number }>;
  citations: Array<{ domain: string; ordinal: number }>;
  mentionCounts: Record<string, number>;
  sentimentPerMention: Array<{ mentionIndex: number; label: "pos" | "neg" | "neutral" }>;
}

export interface CaptureVisibilityResult {
  runId: string;
  cell: CaptureCell;
  fromCache: boolean;
  ageMs: number;
}

function jobFor(engine: VisibilityEngine, promptId: string): string {
  return `visibility.${engine}.${promptId}`;
}

/**
 * `research.captureVisibility` (RFC-04 Phase 3): one (prompt × engine) cell,
 * cached and freshness-enforced exactly like `research.pull` — cell
 * identity is `(engine, promptId)`, not the generic `job` string, since the
 * SEO/GEO capture matrix is fixed-shape (N prompts × 5 engines), not
 * free-form research queries.
 *
 * Phase 1 has no real capture adapter wired up yet (first-party Perplexity
 * Sonar / Claude web_search / Gemini grounding APIs, or a paid tracker for
 * ChatGPT + Copilot) — production adapter wiring is a follow-up swap, not a
 * change to this tool's contract. The stand-in cell is honestly
 * `captureTier: "UNAVAILABLE"` (never a fabricated MEASURED/ESTIMATED
 * answer) so `grade_data_only_rule` downstream in `seoGeo.score` correctly
 * excludes it from any grade and from `N_e`.
 */
export function createCaptureVisibility(store: WorkspaceStoreLike) {
  return defineTool<CaptureVisibilityInput, CaptureVisibilityResult>({
    name: "research.captureVisibility",
    version: TOOL_VERSION,
    inputSchema: CaptureVisibilityInputSchema,
    async execute({ promptId, engine, window }, { ctx }) {
      const windowMs = parseDurationMs(window);
      const job = jobFor(engine, promptId);
      const cached = await latestRun(store, ctx.clientSlug, job);

      if (cached) {
        const ageMs = Date.now() - cached.at;
        if (ageMs <= windowMs) {
          return success<CaptureVisibilityResult>({ runId: cached.runId, cell: cached.result as CaptureCell, fromCache: true, ageMs });
        }
      }

      const runId = randomUUID();
      const cell: CaptureCell = {
        promptId,
        engine,
        captureTier: "UNAVAILABLE",
        brandMentioned: false,
        brandCited: false,
        competitorsNamed: [],
        citations: [],
        mentionCounts: {},
        sentimentPerMention: [],
      };
      const record: RunRecord = { job, runId, query: promptId, result: cell, at: Date.now() };
      await store.writeJson(ctx.clientSlug, runSegments(job, runId), record);

      return success<CaptureVisibilityResult>({ runId, cell, fromCache: false, ageMs: 0 });
    },
  });
}
