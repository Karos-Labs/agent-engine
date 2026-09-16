import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/**
 * C7 (`docs/contracts/C7-run-context.md`, SCRUM-458): the platform keys a
 * learning context is projected under. The engine's own platform vocabulary,
 * not a product id — `x-agent` and a future `x-engagement-agent` read the
 * same `x` state.
 */
export const LEARNING_PLATFORMS = ["x", "linkedin", "reddit", "instagram", "tiktok"] as const;
export type LearningPlatform = (typeof LEARNING_PLATFORMS)[number];

/**
 * The seven per-platform files C7 §2 defines, by their file name. The order
 * here is the order `readiness.present`/`absent` report them in, so a log
 * line reads the same across runs.
 */
export const LEARNING_DOC_KINDS = ["platform-state", "subject-window", "feedback", "what-works", "strategy-map", "craft"] as const;
export type LearningDocKind = (typeof LEARNING_DOC_KINDS)[number];
/** The one client-wide file, not under a platform. */
export const PREFERENCES_KIND = "preferences" as const;

export const GetLearningContextInputSchema = z.object({
  platform: z.enum(LEARNING_PLATFORMS).describe("Which platform's projected learning context to read: x, linkedin, reddit, instagram or tiktok."),
});
export type GetLearningContextInput = z.infer<typeof GetLearningContextInputSchema>;

/** C7 §2.0 — the provenance every projected file carries. Returned verbatim; never recomputed here. */
export interface LearningDocSource {
  projectedAt: string;
  projectedBy: string;
  contentHash: string;
  rows?: number;
}

/** C7 §2.1 */
export interface PlatformStateDoc {
  account?: { handle?: string; url?: string };
  followers?: number;
  postsTotal?: number;
  postsByUs?: number;
  topPosts?: Array<{ url?: string; why?: string; metric?: string }>;
  whatWorks?: string[];
  options?: string[];
  voiceNotes?: string[];
  lastUpdated?: string;
}

/** C7 §2.2 */
export interface SubjectWindowRow {
  id?: string;
  runId?: string;
  subject: string;
  angle?: string;
  type?: string;
  stage?: string;
  goal?: string;
  status?: string;
  draftedAt?: string;
  postedAt?: string;
}
export interface SubjectWindowDoc {
  windowDays?: number;
  rows: SubjectWindowRow[];
}

/** C7 §2.3 */
export interface FeedbackRow {
  runId?: string;
  account?: string;
  action: string;
  reason?: string | null;
  originalText?: string | null;
  finalText?: string | null;
  at?: string;
}
export interface FeedbackDoc {
  rows: FeedbackRow[];
}

/** C7 §2.4 */
export interface PreferencesDoc {
  neverTopics?: string[];
  likes?: Array<{ note?: string; postRef?: string }>;
  voiceNotes?: Array<{ lesson?: string; fromRunId?: string }>;
  standingInstructions?: string[];
  derivedAt?: string;
  derivedFromCount?: number;
}

/** C7 §2.5 */
export interface WhatWorksDoc {
  outliers?: Array<{ postRef?: string; trait?: string; lift?: number }>;
  rules?: Array<{ id: string; rule: string; sampleSize?: number; since?: string }>;
  regeneratedAt?: string;
}

/** C7 §2.6 */
export interface StrategyMapRow {
  id: string;
  problem?: string;
  stage: string;
  idea: string;
  type?: string;
  evidence?: string;
  status?: string;
}
export interface StrategyMapDoc {
  platform?: string;
  builtAt?: string;
  source?: string;
  audience?: Array<{ role?: string; problems?: string[] }>;
  rows: StrategyMapRow[];
  defaultMix?: { attention?: number; expertise?: number; decide?: number };
}

/** C7 §2.7 */
export interface CraftRule {
  id: string;
  layer: string;
  kind: string;
  rule: string;
  why?: string;
  metric?: string;
  sampleSize?: number;
}
export interface CraftDoc {
  platform?: string;
  rules: CraftRule[];
  overrides?: Array<{ winner: string; loser: string }>;
}

/**
 * What `client.getLearningContext` hands back: each document's `data` when
 * the file was present and well-formed, and the readiness line that says
 * which were. `sources` keeps the provenance for whoever wants to print how
 * stale a projection was.
 */
export interface LearningContext {
  platform: LearningPlatform;
  platformState?: PlatformStateDoc;
  subjectWindow?: SubjectWindowDoc;
  feedback?: FeedbackDoc;
  preferences?: PreferencesDoc;
  whatWorks?: WhatWorksDoc;
  strategyMap?: StrategyMapDoc;
  craft?: CraftDoc;
  sources: Partial<Record<LearningDocKind | typeof PREFERENCES_KIND, LearningDocSource>>;
  readiness: { present: string[]; absent: string[] };
}

interface Envelope {
  kind?: unknown;
  platform?: unknown;
  data?: unknown;
  source?: unknown;
}

/**
 * A projected file is usable when it has an object `data`. Anything else —
 * missing, a bare array, a string, `null` — counts as absent, because a
 * malformed projection is the projector's bug and must not become the run's
 * held status. C7 invariant 1.
 */
function unwrap(envelope: Envelope | undefined): { data: Record<string, unknown>; source: LearningDocSource | undefined } | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const source = envelope.source;
  return {
    data: data as Record<string, unknown>,
    source: source && typeof source === "object" ? (source as LearningDocSource) : undefined,
  };
}

/** Rows-bearing documents are only usable when `rows` is an array; an object with no rows is an empty window, which is fine. */
function rowsOf<T>(data: Record<string, unknown>): T[] {
  return Array.isArray(data.rows) ? (data.rows as T[]) : [];
}

/**
 * `client.getLearningContext` — everything the platform has learned about
 * this client on one platform, as projected into the workspace before the
 * run (C7 §2). The read side of build-plan item A1.
 *
 * Seven files, all optional. The tool never reports `not_available` and
 * never throws: an agent that has nothing projected yet must draft exactly
 * as it did before this tool existed, and the caller learns what was there
 * from `readiness`, not from an error. This is the same stance as
 * `readContextDoc`, taken one level down so every workflow gets it for free.
 *
 * Reads `data` only. Who projected the file, from which database, and how
 * stale it is, are in `source` and are passed through for logging — the run
 * does not care and must not: C7 invariant 3 is that the engine reads its
 * workspace and nothing else.
 */
export function createGetLearningContext(store: WorkspaceStoreLike) {
  return defineTool<GetLearningContextInput, LearningContext>({
    name: "client.getLearningContext",
    description:
      "Everything the platform has learned about this client on one platform, projected into the workspace before the run: platform state, the anti-repetition subject window, recent client feedback, derived preferences, what works, the strategy map and the craft rules. Every part is optional; the readiness line says which were present. Never fails a run.",
    version: TOOL_VERSION,
    inputSchema: GetLearningContextInputSchema,
    async execute({ platform }, { ctx }) {
      const present: string[] = [];
      const absent: string[] = [];
      const sources: LearningContext["sources"] = {};
      const out: LearningContext = { platform, sources, readiness: { present, absent } };

      const read = async (kind: LearningDocKind | typeof PREFERENCES_KIND): Promise<Record<string, unknown> | undefined> => {
        const segments = kind === PREFERENCES_KIND ? ["context", "learning", kind] : ["context", "learning", platform, kind];
        let envelope: Envelope | undefined;
        try {
          envelope = await store.readJson<Envelope>(ctx.clientSlug, segments);
        } catch (error) {
          console.error(`client.getLearningContext: could not read ${segments.join("/")} for "${ctx.clientSlug}", treating it as absent`, error);
          envelope = undefined;
        }
        const unwrapped = unwrap(envelope);
        if (!unwrapped) {
          absent.push(kind);
          return undefined;
        }
        present.push(kind);
        if (unwrapped.source) sources[kind] = unwrapped.source;
        return unwrapped.data;
      };

      const platformState = await read("platform-state");
      if (platformState) out.platformState = platformState as PlatformStateDoc;

      const subjectWindow = await read("subject-window");
      if (subjectWindow) {
        out.subjectWindow = {
          ...(typeof subjectWindow.windowDays === "number" ? { windowDays: subjectWindow.windowDays } : {}),
          rows: rowsOf<SubjectWindowRow>(subjectWindow).filter((r) => r && typeof r.subject === "string"),
        };
      }

      const feedback = await read("feedback");
      if (feedback) out.feedback = { rows: rowsOf<FeedbackRow>(feedback).filter((r) => r && typeof r.action === "string") };

      const whatWorks = await read("what-works");
      if (whatWorks) out.whatWorks = whatWorks as WhatWorksDoc;

      let strategyMap = await read("strategy-map");
      if (!strategyMap) {
        // SCRUM-464: a map the ENGINE built on a setup / first run lives at
        // `state/<platform>/strategy-map.json` until the middleware collects
        // and projects it. Reading it here means the run after the one that
        // built it does not build again (and pay again) in the gap. Marked
        // `projectedBy: "engine-run"` so the readiness line says where it
        // came from.
        let built: Record<string, unknown> | undefined;
        try {
          built = await store.readJson<Record<string, unknown>>(ctx.clientSlug, ["state", platform, "strategy-map"]);
        } catch {
          built = undefined;
        }
        if (built && typeof built === "object" && !Array.isArray(built) && Array.isArray(built.rows)) {
          absent.splice(absent.indexOf("strategy-map"), 1);
          present.push("strategy-map");
          sources["strategy-map"] = { projectedAt: typeof built.builtAt === "string" ? built.builtAt : "", projectedBy: "engine-run", contentHash: "" };
          strategyMap = built;
        }
      }
      if (strategyMap) {
        const map = strategyMap as unknown as StrategyMapDoc;
        out.strategyMap = {
          ...map,
          rows: rowsOf<StrategyMapRow>(strategyMap).filter((r) => r && typeof r.id === "string" && typeof r.idea === "string" && typeof r.stage === "string"),
        };
      }

      const craft = await read("craft");
      if (craft) {
        const doc = craft as unknown as CraftDoc;
        out.craft = {
          ...doc,
          rules: (Array.isArray(doc.rules) ? doc.rules : []).filter((r) => r && typeof r.id === "string" && typeof r.rule === "string"),
        };
      }

      const preferences = await read(PREFERENCES_KIND);
      if (preferences) out.preferences = preferences as PreferencesDoc;

      return success<LearningContext>(out);
    },
  });
}
