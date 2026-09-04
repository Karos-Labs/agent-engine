import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, parseDurationMs, success } from "@agent-engine/tool-common";
import { latestRun, writeRunRecord, type RunRecord } from "./runs.js";

// 1.1.0 (SCRUM-396): the accepted engine set widened from five to seven
// (`aimode`/`google_aio` added). A cell captured under 1.0.0 came from a tool
// whose input enum would have REJECTED either of those engines, so the two are
// genuinely different contracts and telemetry must be able to tell them apart.
//
// 1.2.0: three changes to what a cell MEANS, which is why this is not a patch.
//   - `clientBrandName` joins the input, and mention detection matches on it.
//     A 1.1.0 cell reporting `brandMentioned: false` for a multi-word brand was
//     answering a question about a domain-derived token, not about the brand.
//   - Cell identity gains the prompt TEXT (`jobFor`), so a reworded prompt no
//     longer inherits the previous question's answer from its slot.
//   - A `no_adapter_wired` cell is no longer served from cache once an adapter
//     exists — that tier is a statement about configuration, not measurement.
// Every one of those changes what a stored cell asserts, so a reader comparing
// two runs has to be able to tell which contract produced which.
const TOOL_VERSION = "1.2.0";

/**
 * The ratified AI-visibility engines (SCRUM-396).
 *
 * Deliberately a second literal rather than an import: RFC-01 §4 keeps tool
 * packages independent of each other, so `karos-research` cannot depend on
 * `karos-seo-geo`. That independence is what made this list drift in the first
 * place, so the two are pinned equal by a conformance test in the one workspace
 * that legitimately sees both — `agents/seo-geo-agent`'s
 * `visibility-engine-list.test.ts`. **Change one and that test fails; change
 * both without reading `docs/decisions/SCRUM-396-visibility-engine-list.md`
 * and you will re-make the mistake it records.**
 *
 * `aimode`/`google_aio` are accepted here so a cell can be captured and stored
 * the moment an adapter exists; neither has one in this build, and
 * `createDefaultCaptureAdapters` simply omits them, which this tool already
 * reports as an honest `UNAVAILABLE`/`no_adapter_wired` cell.
 */
export const VISIBILITY_ENGINES = ["chatgpt", "perplexity", "gemini", "claude", "copilot", "aimode", "google_aio"] as const;
export type VisibilityEngine = (typeof VISIBILITY_ENGINES)[number];

export const CAPTURE_TIERS = ["MEASURED", "MEASURED_grounded", "ESTIMATED", "UNAVAILABLE"] as const;
export type CaptureTier = (typeof CAPTURE_TIERS)[number];

export const CaptureVisibilityInputSchema = z.object({
  // promptId/promptText/engine/clientDomains/competitorRoster have no existing TSDoc to transcribe (SCRUM-293 flag) — synthesized from CaptureCell's usage and the tool's own doc comment.
  promptId: z.string().min(1).describe("Which prompt in the fixed capture matrix this cell is for."),
  promptText: z.string().min(1).describe("The exact prompt text sent to the AI-visibility engine."),
  engine: z.enum(VISIBILITY_ENGINES).describe("Which ratified AI-visibility engine this cell captures (SCRUM-396: chatgpt, perplexity, gemini, claude, copilot, aimode, google_aio)."),
  clientDomains: z.array(z.string()).min(1).describe("The client's own domains, to detect whether/where the client's brand is mentioned or cited."),
  competitorRoster: z.array(z.string()).default([]).describe("Competitor brand ids to detect being named in the engine's answer."),
  clientBrandName: z
    .string()
    .optional()
    .describe(
      "The client's brand as a person writes it (\"Karos Labs\"). Required for mention detection to work on any multi-word brand: matching is a literal substring test, and a domain-derived token (\"karoslabs\") never appears in an answer that says \"Karos Labs\".",
    ),
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
  /**
   * Gemini-only (T-A3/SCRUM-237): true when Google's AI Overview /
   * Grounding-with-Google-Search equivalent genuinely did not render for
   * this query at all (no grounding chunks came back) — distinct from
   * `brandMentioned: false`, which means an answer (grounded or not) DID
   * come back and simply never named the brand. Conflating the two would
   * hide a real "AIO isn't showing for this prompt" signal inside what
   * looks like an ordinary brand-absent miss. `undefined` for every other
   * engine, and for Gemini whenever grounding DID render.
   */
  aioAbsent?: boolean;
}

/**
 * What one real engine adapter is handed to capture one (prompt × engine)
 * answer (T-A3/SCRUM-237) — deliberately the same fields
 * `CaptureVisibilityInput` already carries, nothing more: an adapter gets
 * exactly what a human reviewer approved at the prompt-set gate (step 03)
 * and nothing it could use to fabricate context the run never actually gave
 * it.
 */
export interface EngineCaptureRequest {
  promptId: string;
  promptText: string;
  engine: VisibilityEngine;
  clientDomains: readonly string[];
  competitorRoster: readonly string[];
  /** The client's brand as written — see `AnalyzeAnswerInput.clientBrandName` for why a domain is not enough. */
  clientBrandName?: string;
}

/**
 * What a real engine adapter hands back — everything `CaptureCell` needs
 * except `promptId`/`engine` (the tool already knows those) and `rawSha256`
 * (hashed by the tool itself, over `rawPayload`, so every adapter freezes
 * provenance the same way rather than each computing its own hash).
 */
export interface EngineCaptureAdapterResult {
  captureTier: CaptureTier;
  brandMentioned: boolean;
  brandFirstMentionCharOffset?: number;
  brandCited: boolean;
  brandFirstCitationOrdinal?: number;
  competitorsNamed: Array<{ brandId: string; charOffset: number }>;
  citations: Array<{ domain: string; ordinal: number }>;
  mentionCounts: Record<string, number>;
  sentimentPerMention: Array<{ mentionIndex: number; label: "pos" | "neg" | "neutral" }>;
  /** The frozen raw provider payload this cell is derived from — hashed into `rawSha256`, never scored directly. */
  rawPayload: unknown;
  aioAbsent?: boolean;
}

/**
 * One real capture per (prompt × engine) pair (T-A3/SCRUM-237): makes the
 * actual provider call (Perplexity Sonar, Anthropic Messages + `web_search`,
 * Gemini Grounding with Google Search, or a ScrappyCoco CLI route for
 * ChatGPT/Copilot — see `capture-adapters/index.ts`) and returns the result.
 * Throwing signals a genuine capture failure (`tooling_error` — RFC-01 §5.6:
 * a broken provider call is never a content verdict), NOT "nothing to
 * report"; an engine with nothing to say is still a successful capture with
 * `brandMentioned: false`.
 */
export type EngineCaptureAdapter = (request: EngineCaptureRequest) => Promise<EngineCaptureAdapterResult>;

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
  /**
   * Per-engine real capture adapters (T-A3/SCRUM-237) — the drop-in swap
   * this tool's contract was always designed for (see this file's own
   * header comment). An engine with no adapter here still gets an honest
   * `UNAVAILABLE`/`no_adapter_wired` cell, exactly as before this ticket —
   * so a deployment can wire up Perplexity/Claude/Gemini/ChatGPT/Copilot one
   * at a time (or not at all) without any of this tool's callers noticing
   * anything beyond the cells that engine now produces.
   */
  adapters?: Partial<Record<VisibilityEngine, EngineCaptureAdapter>>;
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

/**
 * A cell's cache identity: the engine, the prompt SLOT, and the prompt TEXT.
 *
 * The text is load-bearing and was missing. `promptId` is a slot number
 * (`prompt_11`), not a question — so when a prompt set's wording changes, the
 * new question inherits the old question's cached answer for up to the full
 * freshness window. That is not a stale measurement, it is a measurement OF
 * SOMETHING ELSE, filed under a prompt nobody asked.
 *
 * It nearly landed: `prompt_11` was "Which AI Digital Marketing brand is most
 * often recommended by industry analysts?" and became "What is Karos Labs, and
 * what do they do?" — the brand-intent rewrite that took Gemini from naming the
 * client in 0 of 10 brand prompts to 5 of 5. Keyed on the slot alone, every one
 * of those new prompts would have replayed the old category answer and the fix
 * would have looked like it changed nothing.
 *
 * Hashing the text rather than embedding it keeps the key short and stable;
 * eight hex characters is ample to separate the prompts of one client's matrix.
 * A reworded prompt simply misses cache and is captured for real, which is the
 * correct behaviour and needs no migration or manual invalidation.
 */
function jobFor(engine: VisibilityEngine, promptId: string, promptText: string): string {
  return `visibility.${engine}.${promptId}.${sha256Hex(promptText).slice(0, 8)}`;
}

/**
 * `research.captureVisibility` (RFC-04 Phase 3): one (prompt × engine) cell,
 * cached and freshness-enforced exactly like `research.pull` — cell identity
 * is `(engine, promptId, promptText)`, not the generic `job` string, since the
 * SEO/GEO capture matrix is fixed-shape (N prompts × 5 engines), not free-form
 * research queries. The TEXT is part of that identity and not decoration: see
 * `jobFor` for the reworded-prompt case it exists to stop.
 *
 * T-A3/SCRUM-237: a real `options.adapters[engine]` now performs a genuine
 * capture (Perplexity Sonar, Claude + `web_search`, Gemini Grounding with
 * Google Search, or a ScrappyCoco CLI route for ChatGPT/Copilot). An engine
 * with NO adapter configured still gets the honest Phase 1 stand-in cell —
 * `captureTier: "UNAVAILABLE"` / `unavailableReason: "no_adapter_wired"`,
 * never a fabricated MEASURED/ESTIMATED answer — exactly as before this
 * ticket, so `grade_data_only_rule` downstream in `seoGeo.score` correctly
 * excludes it from any grade and from `N_e`.
 */
export function createCaptureVisibility(store: WorkspaceStoreLike, options: CaptureVisibilityToolOptions = {}) {
  return defineTool<CaptureVisibilityInput, CaptureVisibilityResult>({
    name: "research.captureVisibility",
    description:
      "Captures one (prompt x engine) AI-visibility cell, cached and freshness-enforced like research.pull. An engine with a real adapter configured (Perplexity/Claude/Gemini/ChatGPT/Copilot) captures for real; every other engine (Google AI Mode and AI Overview have no adapter in this build) reports the honest stand-in, captureTier: \"UNAVAILABLE\", rather than a fabricated measurement.",
    version: TOOL_VERSION,
    inputSchema: CaptureVisibilityInputSchema,
    async execute({ promptId, promptText, engine, clientDomains, competitorRoster, clientBrandName, window }, { ctx }) {
      const windowMs = parseDurationMs(window);
      const job = jobFor(engine, promptId, promptText);
      const cached = await latestRun(store, ctx.clientSlug, job);

      if (cached) {
        const ageMs = Date.now() - cached.at;
        // A `no_adapter_wired` cell is a statement about THIS DEPLOYMENT'S
        // CONFIGURATION, not about what an engine said — so it must not be
        // served from cache once the adapter exists. The freeze rule below is
        // about measurement conditions ("capture_tier set at capture per cell
        // and frozen; never silently upgraded"), and an engine that was not
        // wired was never measured at all.
        //
        // Wiring Gemini and ChatGPT and seeing nothing change is what this
        // costs otherwise: on 2026-09-04 a run served 25 day-old
        // `no_adapter_wired` Gemini cells from a 30-day window, so a working
        // adapter sat unused and the client's coverage stayed exactly where it
        // was. ChatGPT looked fixed only because its earlier cells had failed
        // outright and left nothing to cache.
        const cachedCell = cached.result as CaptureCell;
        const supersededByNewAdapter =
          cachedCell.captureTier === "UNAVAILABLE" &&
          cachedCell.unavailableReason === "no_adapter_wired" &&
          options.adapters?.[engine] !== undefined;
        if (ageMs <= windowMs && !supersededByNewAdapter) {
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

      if (!probe.ok) {
        // A credit probe rejecting a cell mid-batch is a real, per-cell
        // degradation event (`degradation`'s "Perplexity credit pre-flight
        // probe + per-cell 402 handling") — the adapter (if any) is never
        // even called for this cell.
        const cell = buildUnavailableCell(promptId, engine, "credit_probe_402", { reason: "credit_probe_402", promptId, engine, probeStatus: probe.status ?? 402 });
        const record: RunRecord = { job, runId, query: promptId, result: cell, at: Date.now() };
        await writeRunRecord(store, ctx.clientSlug, record);
        return success<CaptureVisibilityResult>({ runId, cell, fromCache: false, ageMs: 0 });
      }

      const adapter = options.adapters?.[engine];
      let cell: CaptureCell;
      if (adapter === undefined) {
        // This environment's permanent state for an engine with no real
        // adapter configured — distinct from the credit-probe branch above,
        // never conflated (`unavailableReason`).
        cell = buildUnavailableCell(promptId, engine, "no_adapter_wired", { reason: "no_adapter_wired", promptId, engine });
      } else {
        // A genuine capture failure (the provider call itself broke) is
        // `tooling_error`, never silently downgraded to an UNAVAILABLE cell
        // — RFC-01 §5.6: that distinction is exactly what let a broken
        // research pipeline read as "a topic with nothing to say" for
        // months (see `research.pull`'s own doc comment for the same rule).
        const adapterResult = await adapter({ promptId, promptText, engine, clientDomains, competitorRoster, ...(clientBrandName ? { clientBrandName } : {}) });
        cell = {
          promptId,
          engine,
          captureTier: adapterResult.captureTier,
          brandMentioned: adapterResult.brandMentioned,
          ...(adapterResult.brandFirstMentionCharOffset !== undefined ? { brandFirstMentionCharOffset: adapterResult.brandFirstMentionCharOffset } : {}),
          brandCited: adapterResult.brandCited,
          ...(adapterResult.brandFirstCitationOrdinal !== undefined ? { brandFirstCitationOrdinal: adapterResult.brandFirstCitationOrdinal } : {}),
          competitorsNamed: adapterResult.competitorsNamed,
          citations: adapterResult.citations,
          mentionCounts: adapterResult.mentionCounts,
          sentimentPerMention: adapterResult.sentimentPerMention,
          rawSha256: sha256Hex(adapterResult.rawPayload),
          ...(adapterResult.aioAbsent !== undefined ? { aioAbsent: adapterResult.aioAbsent } : {}),
        };
      }

      const record: RunRecord = { job, runId, query: promptId, result: cell, at: Date.now() };
      await writeRunRecord(store, ctx.clientSlug, record);

      return success<CaptureVisibilityResult>({ runId, cell, fromCache: false, ageMs: 0 });
    },
  });
}
