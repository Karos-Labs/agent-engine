import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, parseDurationMs, success } from "@agent-engine/tool-common";
import { latestRun, writeRunRecord, type RunRecord } from "./runs.js";

const TOOL_VERSION = "1.0.0";

/** The 5 fixed AI-visibility engines (RFC-04 Phase 3 — `seo-geo-capture-config.json` `engines[]`). */
export const VISIBILITY_ENGINES = ["chatgpt", "perplexity", "gemini", "claude", "copilot"] as const;
export type VisibilityEngine = (typeof VISIBILITY_ENGINES)[number];

export const CAPTURE_TIERS = ["MEASURED", "MEASURED_grounded", "ESTIMATED", "UNAVAILABLE"] as const;
export type CaptureTier = (typeof CAPTURE_TIERS)[number];

export const CaptureVisibilityInputSchema = z.object({
  // promptId/promptText/engine/clientDomains/competitorRoster have no existing TSDoc to transcribe (SCRUM-293 flag) — synthesized from CaptureCell's usage and the tool's own doc comment.
  promptId: z.string().min(1).describe("Which prompt in the fixed capture matrix this cell is for."),
  promptText: z.string().min(1).describe("The exact prompt text sent to the AI-visibility engine."),
  engine: z.enum(VISIBILITY_ENGINES).describe("Which of the 5 fixed AI-visibility engines this cell captures (chatgpt, perplexity, gemini, claude, copilot)."),
  clientDomains: z.array(z.string()).min(1).describe("The client's own domains, to detect whether/where the client's brand is mentioned or cited."),
  competitorRoster: z.array(z.string()).default([]).describe("Competitor brand ids to detect being named in the engine's answer."),
  /** Freshness window, same convention as `research.pull` — a cached cell inside this window is returned instead of re-capturing. */
  window: z.string().min(1).describe("Freshness window, same convention as research.pull — a cached cell inside this window is returned instead of re-capturing."),
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
  /**
   * SHA-256 over the frozen raw provider payload this cell was derived from
   * (`response_set.per_prompt_engine_fields`'s `raw_sha256`) — provenance
   * only, never fed to any scoring metric
   * (`non_scoring_fields.provenance`), but present on EVERY cell so that
   * re-scoring the frozen response set never has to re-query a provider:
   * scoring reads the already-parsed cell fields, and this hash is what
   * proves those fields trace back to one specific frozen raw blob rather
   * than a re-derivation.
   */
  rawSha256: string;
  /**
   * Set only when `captureTier` is `UNAVAILABLE` because a pre-flight
   * credit probe rejected this specific cell (`degradation`'s "Perplexity
   * credit pre-flight probe + per-cell 402 handling") — distinguishes a
   * credit-exhaustion UNAVAILABLE from "no capture adapter wired yet" so
   * the two failure modes are never conflated in review.
   */
  unavailableReason?: "credit_probe_402" | "no_adapter_wired";
}

export interface CaptureVisibilityResult {
  runId: string;
  cell: CaptureCell;
  fromCache: boolean;
  ageMs: number;
}

/**
 * A pre-flight credit check for one (engine, promptId) cell
 * (`seo-geo-capture-config.json` `engines[].limits`: Perplexity's key "runs
 * on DRAINING CREDITS" — "Pre-flight credit probe AND per-cell 402 handling
 * mid-batch: a cell that 402s flips to UNAVAILABLE with a logged note,
 * never a silent zero; tiering is per cell, not a binary per-engine flip").
 * `status` carries the provider's HTTP-style status when `ok` is false —
 * `402` is the documented credit-exhaustion case, but any non-ok status is
 * treated the same way (never guessed into MEASURED/ESTIMATED).
 */
export interface CreditProbeResult {
  ok: boolean;
  status?: number;
}

/**
 * Called once per cell, before capture — same per-cell (not per-engine)
 * granularity the config calls for, so an engine's credits can run out
 * mid-batch (first N prompts succeed, the rest 402) without that reading as
 * "this whole engine is down." Omitted entirely (the default) means every
 * cell probes `{ ok: true }` — i.e. today's stand-in behavior is unchanged
 * until a real provider client supplies one.
 */
export type CreditProbe = (engine: VisibilityEngine, promptId: string) => Promise<CreditProbeResult>;

export interface CaptureVisibilityToolOptions {
  creditProbe?: CreditProbe;
}

/** Stable SHA-256 over any JSON-serializable value — same convention as `seo-geo-agent`'s `sha256Hex` (internally consistent and deterministic; not required to match any external/legacy hash format). */
function sha256Hex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/**
 * Builds an honest `UNAVAILABLE` cell, always carrying a frozen `rawSha256`
 * over whatever raw payload backs this terminal state — never a fabricated
 * MEASURED/ESTIMATED answer (`capture_label_default` is only ever assigned
 * by a real capture, which no adapter here performs yet). `unavailableReason`
 * keeps "a credit probe rejected this cell" distinguishable from "no capture
 * adapter is wired for this engine yet" — two different failure modes that
 * must never be conflated in review (`degradation`'s per-cell 402 handling).
 */
function buildUnavailableCell(
  promptId: string,
  engine: VisibilityEngine,
  unavailableReason: "credit_probe_402" | "no_adapter_wired",
  rawPayload: unknown,
): CaptureCell {
  return {
    promptId,
    engine,
    captureTier: "UNAVAILABLE",
    brandMentioned: false,
    brandCited: false,
    competitorsNamed: [],
    citations: [],
    mentionCounts: {},
    sentimentPerMention: [],
    rawSha256: sha256Hex(rawPayload),
    unavailableReason,
  };
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
export function createCaptureVisibility(store: WorkspaceStoreLike, options: CaptureVisibilityToolOptions = {}) {
  return defineTool<CaptureVisibilityInput, CaptureVisibilityResult>({
    name: "research.captureVisibility",
    description:
      "Captures one (prompt x engine) AI-visibility cell, cached and freshness-enforced like research.pull. Phase 1 has no real capture adapter wired up yet, so the stand-in cell is honestly captureTier: \"UNAVAILABLE\" rather than a fabricated measurement.",
    version: TOOL_VERSION,
    inputSchema: CaptureVisibilityInputSchema,
    async execute({ promptId, engine, window }, { ctx }) {
      const windowMs = parseDurationMs(window);
      const job = jobFor(engine, promptId);
      const cached = await latestRun(store, ctx.clientSlug, job);

      if (cached) {
        const ageMs = Date.now() - cached.at;
        if (ageMs <= windowMs) {
          // Frozen per cell: a cache hit inside the freshness window returns
          // the EXACT stored record, `captureTier`/`rawSha256` included —
          // `capture_tier` is never silently upgraded (or downgraded) just
          // because conditions changed since capture (`parsing_rules`:
          // "capture_tier set at capture PER CELL and frozen; never
          // silently upgraded").
          return success<CaptureVisibilityResult>({ runId: cached.runId, cell: cached.result as CaptureCell, fromCache: true, ageMs });
        }
      }

      const runId = randomUUID();
      const probe = options.creditProbe ? await options.creditProbe(engine, promptId) : { ok: true };

      // Phase 1 has no real capture adapter wired up yet (first-party
      // Perplexity Sonar / Claude web_search / Gemini grounding APIs, or a
      // paid tracker for ChatGPT + Copilot) — production adapter wiring is a
      // follow-up swap, not a change to this tool's contract. Both terminal
      // paths below are honestly `UNAVAILABLE` (never a fabricated
      // MEASURED/ESTIMATED answer), but they are NOT the same failure and
      // must not be reported as if they were: a credit probe rejecting a
      // cell mid-batch is a real, per-cell degradation event; "no adapter
      // wired" is this environment's permanent Phase 1 state.
      const cell: CaptureCell = probe.ok
        ? buildUnavailableCell(promptId, engine, "no_adapter_wired", { reason: "no_adapter_wired", promptId, engine })
        : buildUnavailableCell(promptId, engine, "credit_probe_402", {
            reason: "credit_probe_402",
            promptId,
            engine,
            probeStatus: probe.status ?? 402,
          });

      const record: RunRecord = { job, runId, query: promptId, result: cell, at: Date.now() };
      await writeRunRecord(store, ctx.clientSlug, record);

      return success<CaptureVisibilityResult>({ runId, cell, fromCache: false, ageMs: 0 });
    },
  });
}
