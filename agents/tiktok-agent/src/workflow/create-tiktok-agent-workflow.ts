import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSrt } from "@agent-engine/tool-karos-video";
import { downloadBrandLogo, planBrandLogoPlacement, readBrandLogoInk } from "@agent-engine/tool-karos-media";
import {
  evaluateDedupe,
  readForbiddenTopics,
  shingles,
  type AgentContext,
  type AgentToolRegistry,
  type GateVerdict,
  type ModelRouter,
  type PromptStore,
  firstAsset,
} from "@agent-engine/core";
import {
  AwaitingGateSignal,
  MAX_REVISION_ROUNDS,
  WorkflowBlockedIntake,
  WorkflowHeld,
  WorkflowToolingFailure,
  checkOutputDedupe,
  dedupeDirective,
  dedupeRetryDirective,
  persistReviewFeedbackToMemory,
  readClientIntelContext,
  readOutputHistoryForDedup,
  readPastFeedback,
  readRunDirection,
  revisionDirective,
  runDirectionField,
  runReviewCycle,
  runTopicGuardrail,
  toAgentContext,
  type RevisionNote,
  type WorkflowContext,
} from "@agent-engine/workflow";
import { normalizeBannedDashes } from "@agent-engine/tool-common";
import { TikTokCommentaryAgent } from "../agent/tiktok-commentary-agent.js";
import { TikTokMomentAgent } from "../agent/tiktok-moment-agent.js";
import { TikTokScriptAgent } from "../agent/tiktok-script-agent.js";
import { TikTokTopicScoutAgent } from "../agent/tiktok-topic-scout-agent.js";
import { boundsFromTranscript, sentenceBoundedWords, type TranscriptWordLike } from "./clip-bounds.js";
import {
  CLIP_DURATION_MAX_SECONDS,
  CLIP_DURATION_MIN_SECONDS,
  CLIP_LANE,
  DEFAULT_CLIP_CONFIG,
  MomentSelectionSchema,
  ShortScriptSchema,
  TikTokClipConfigSchema,
  TopicScoutOutputSchema,
  type ClipCopy,
  type ClipFormat,
  type Commentary,
  type MomentSelection,
  type ShortScript,
  type TikTokAgentWorkflowResult,
  type TikTokClipConfig,
  type TikTokIntake,
  type TopicCandidate,
  type TopicSource,
} from "./types.js";

export interface CreateTikTokAgentWorkflowOptions {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips the human approval gate and records a synthetic system approval —
   * off by default, matching every other migrated channel. The legacy product
   * is `requires_approval: true` and a draft-status generator "always blocks
   * here for the operator", so a real run genuinely parks at `awaiting_gate`.
   */
  autoApprove?: boolean;
  /**
   * Bounds root for ingesting an attached source video, harvesting footage,
   * and generating b-roll plates.
   *
   * Optional, unlike instagram's: a run that supplies `sourcePath` needs
   * nothing from here, and that is how every dispatch worked before the portal
   * grew an upload surface. Without it an ATTACHED video is refused with a
   * reason, never read from an unbounded location, and the harvest/generate
   * tiers report themselves as not wired.
   */
  repoRoot?: string;
  /** Injectable for tests; the brand-logo download uses it. */
  fetchImpl?: typeof fetch;
}

/**
 * How many commentary drafts the verified de-duplication check may cost —
 * initial draft plus ONE redraft steer. SCRUM-381 (AU20 left this agent off
 * its capability matrix by mistake — six agents were advisory, not five):
 * `recentPosts` below was already a hard-sounding do-not-repeat directive in
 * the drafting prompt, and nothing ever checked whether the model listened,
 * so a lightly-reworded reissue passed every gate. This is the verification
 * half, `checkOutputDedupe` scoring the same excerpt window against
 * `evaluateDedupe`'s calibrated threshold, in the same place the other five
 * migrated channel agents run their own check: inside the drafting pass, so a
 * `similar` verdict costs the draft rather than reaching the reviewer at
 * 11-clip-review unscored.
 *
 * Deliberately 2, not blog/reddit/x/linkedin/newsletter's 3 — this agent's
 * economics are not theirs. Every attempt here is a drafting call anchored to
 * a real, run-specific brief (a transcript excerpt, or a topic the scout
 * grounded in research), not a free choice of topic and angle the way a blog
 * or X draft is — a near-duplicate here is far more often a stylistic echo
 * than substantive repetition, and one steer quoting the offending prior post
 * is enough to break that the overwhelming majority of the time. This budget
 * only ever costs an extra text call: the expensive steps — the ffmpeg
 * composite, the QA model call, the upload — run once per REVIEW round, after
 * this loop has already settled, never once per dedupe attempt.
 */
const MAX_DEDUPE_ATTEMPTS = 2;

/**
 * Prep run pubsub-21711047251391287 went from a finished script to a held run
 * on a single em dash in one beat's narration. The script and commentary
 * steps now self-critique against `gate.lintPost`, so a dash is normally a
 * revision inside the step; these two are the deterministic backstop for the
 * one that still gets through, applied to exactly the fields 07-compliance
 * lints and 13-commit-and-record writes back into the dedupe window, so every
 * later comparison is against what actually shipped.
 */
export function normalizeScriptDashes(script: ShortScript): ShortScript {
  return {
    ...script,
    hook: normalizeBannedDashes(script.hook),
    caption: normalizeBannedDashes(script.caption),
    about: normalizeBannedDashes(script.about),
    beats: script.beats.map((beat) => ({
      ...beat,
      narration: normalizeBannedDashes(beat.narration),
      onScreenText: normalizeBannedDashes(beat.onScreenText),
    })),
  };
}

/** `sourceCredit` is normalised with the caption it must appear in, so the 07-compliance containment check compares like with like. */
export function normalizeCommentaryDashes(commentary: Commentary): Commentary {
  return {
    caption: normalizeBannedDashes(commentary.caption),
    about: normalizeBannedDashes(commentary.about),
    sourceCredit: normalizeBannedDashes(commentary.sourceCredit),
  };
}

/** Every plate a generated short is built from stays on screen at least this long — under it a cut reads as a glitch. */
const MIN_PLATE_HOLD_SECONDS = 2;

/** The brand furniture the framed clip carries — every field beyond the two grounds optional, skipped when absent. */
interface VideoBrand {
  ground: string;
  fg: string;
  accent?: string;
  handle?: string;
  seriesHeader?: string;
  logoUrl?: string;
  /** The brand kit's stated content language, when it states one — the default voiceover/caption language. */
  language?: string;
}

async function callTool(tools: AgentToolRegistry, name: string, args: unknown, ctx: AgentContext): Promise<unknown> {
  const tool = tools[name];
  if (!tool) throw new WorkflowToolingFailure(`no tool registered as "${name}"`);
  const outcome = await tool.execute(args, { ctx });
  if (outcome.status !== "success") throw new WorkflowToolingFailure(`"${name}" call failed: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
  return outcome.result;
}

/** A gate's verdict. A broken gate is a tooling failure, never a content verdict. */
async function runGate(tools: AgentToolRegistry, name: string, args: unknown, ctx: AgentContext): Promise<GateVerdict> {
  return (await callTool(tools, name, args, ctx)) as GateVerdict;
}

/** Reads `key` off a loose record as a trimmed non-empty string, or nothing. */
function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Reads `key` off a loose record as an array of non-empty strings, or []. */
function readStringList(record: Record<string, unknown> | undefined, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()) : [];
}

/** The same trim-and-lowercase the topic catalog keys on, so "same topic" here means what it means there. */
function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Above this share of a candidate's word-trigrams already sitting inside ONE
 * published post, the candidate is a repeat. Containment rather than Jaccard
 * for this one check, on purpose: `evaluateDedupe`'s Jaccard is calibrated
 * for two DELIVERABLES of similar length, and a three-line topic candidate
 * against a full caption never clears 0.4 even when every word of it is in
 * there — the union is dominated by the caption. Asking "how much of the
 * candidate is already published" is the question actually being asked.
 */
const CANDIDATE_CONTAINMENT_THRESHOLD = 0.6;

/** True when `text` is mostly already inside one of the client's published excerpts. */
function repeatsPublished(text: string, history: readonly { excerpt: string }[]): boolean {
  const own = shingles(text);
  if (own.size === 0) return false;
  for (const entry of history) {
    const published = shingles(entry.excerpt);
    let contained = 0;
    for (const shingle of own) if (published.has(shingle)) contained++;
    if (contained / own.size >= CANDIDATE_CONTAINMENT_THRESHOLD) return true;
  }
  return false;
}

/** Shows/channels the harvest tier may search — the sourcePool minus the entries that are footage URIs. */
function plainSourceNames(config: TikTokClipConfig): string[] {
  return config.sourcePool.filter((entry) => !/^(gs|https?):\/\//i.test(entry));
}

/**
 * `tiktok-agent` — the short-video system: podcast/commentary clips (the
 * product migrated from `karos-tiktok-agent` in the lab repo) and, when there
 * is nothing to clip, an original scripted short.
 *
 * ## What the run does, in order
 *
 *     INTAKE -> SEED -> CLAIM-topic -> FIND-source ->
 *       (footage)  TRANSCRIBE -> PICK-moment -> CUT -> COMPOSE-commentary -> RENDER
 *       (nothing)  SCRIPT -> GENERATE-plates -> VOICE -> RENDER
 *     -> QA -> [approve] -> QUEUE -> LOG
 *
 * One run, one clip — the same unit every other migrated channel agent uses.
 * The per-client settings live in the client's config (`TikTokClipConfigSchema`),
 * so the same code serves every client and the thing that varies is data.
 *
 * ## Where the topic comes from — the smart order
 *
 * 1. A topic the client typed for this run (`requestedTopic`, or a
 *    `customPrompt` that reads as a topic) wins over everything.
 * 2. The catalog lane, seeded from the client's own `guestWatchlist`. This is
 *    the dedup lock: a reserved row is committed only when a clip ships.
 * 3. FOOTAGE THE CLIENT ATTACHED. When a recording was handed to us and the
 *    catalog has nothing to say, the run does not hold — the topic is whatever
 *    the moment step finds in that footage (`topicLabel`), because a client who
 *    uploaded an episode wants a clip from it, not a lecture about their
 *    catalog. The catalog stays advisory for this case: a reserved guest name,
 *    when there is one, steers the moment picker but never forces it.
 * 4. DISCOVERY. No direction, no footage, empty lane: `research.pull` fetches
 *    what the client's field is talking about this week, the scout proposes
 *    6-10 grounded candidates, the dedupe filter drops anything close to what
 *    the client recently published, the survivors seed the lane through
 *    `topics.topUp`, and the run reserves one. From then on the lane has real
 *    rows and the dedup lock works exactly as for a hand-seeded catalog.
 * 5. Only when every one of those is dry does the run hold — naming what it
 *    tried.
 *
 * ## Where the footage comes from — the tiered cascade
 *
 * Attached upload -> the client's own footage URIs in `sourcePool` -> a web
 * harvest restricted to the shows named in `sourcePool` (never the open web)
 * -> generated b-roll. `mode: "commentary"` stops before generation and holds;
 * `mode: "original"` never touches anyone else's footage.
 *
 * ## Where the judgment is
 *
 * Bounded, schema-out model steps, each with a prompt in the store: which
 * moment to clip (Gemini 2.5 Pro — the whole episode has to fit), what to
 * make when nothing was given (scout, Gemini 2.5 Pro), what to say (script /
 * commentary, Claude Sonnet — client voice), and whether the finished clip
 * looks like something a person would post (`video.visualQaGate`, Gemini 2.5
 * Flash watching the MP4). Everything else — reservation, cut bounds, timing,
 * render, the deterministic gates — is code, and a model's timestamps are
 * validated against the transcript rather than trusted.
 *
 * ## Dedup
 *
 * `topics.reserve`/`commit`/`release` IS the legacy catalog: the forward
 * pipeline of candidates and the hard dedup gate in one. A run that fails
 * releases its reservation, so a topic is never burned by a run that shipped
 * nothing. A run PAUSED at the review gate has not failed and keeps its
 * reservation — see the catch around the review cycle. The text-level half is
 * `checkOutputDedupe` against the shipped-output excerpt window.
 *
 * ## Review
 *
 * The `[approve]` step is `runReviewCycle`, the same approve / revise / reject
 * loop every other migrated agent uses. `revise` re-writes the words with the
 * reviewer's note in hand and re-renders the clip around them, in-run: the
 * transcript, the moment, the cut bounds, the generated plates and the brand
 * keep their step ids and are reused, so a revision costs a drafting call and
 * a render rather than a second run's worth of footage.
 */
/**
 * Downloads an attached source video and returns an absolute path to it.
 *
 * Absolute, not repo-relative: the video tools resolve a path against the
 * process cwd, which is the server's, not the agent workspace's. Every other
 * consumer of `media.ingestAssets` renders inside the repo and wants the
 * relative form, so the join happens here rather than in the tool.
 *
 * A failure here is `WorkflowBlockedIntake`, not a tooling error: the run was
 * given footage it cannot read, which is a fact about the input.
 */
async function ingestSourceVideo(
  attached: { uri: string; label?: string | undefined },
  options: CreateTikTokAgentWorkflowOptions,
  tools: AgentToolRegistry,
  runId: string,
  ctx: AgentContext,
): Promise<string> {
  const ingest = tools["media.ingestAssets"];
  if (options.repoRoot === undefined || ingest === undefined) {
    throw new WorkflowBlockedIntake(
      "this run attached a source video, but this deployment cannot ingest one " +
        `(${options.repoRoot === undefined ? "no repoRoot configured" : "media.ingestAssets is not registered"}) — ` +
        "dispatch with a sourcePath the video tools can read instead",
    );
  }

  const outcome = await ingest.execute(
    {
      repoRoot: options.repoRoot,
      runId,
      kind: "video",
      assets: [{ uri: attached.uri, ...(attached.label ? { label: attached.label } : {}), slot: 1 }],
    },
    { ctx },
  );
  if (outcome.status !== "success") {
    throw new WorkflowBlockedIntake(
      `the attached source video could not be ingested (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})`,
    );
  }
  const first = (outcome.result as { candidates: Array<{ path: string }> }).candidates[0];
  if (first === undefined) {
    throw new WorkflowBlockedIntake("the attached source video could not be ingested — no file was written");
  }
  return path.resolve(options.repoRoot, first.path);
}

export function createTikTokAgentWorkflow(options: CreateTikTokAgentWorkflowOptions) {
  const tools = options.tools;

  return async function tiktokAgentWorkflow(wf: WorkflowContext): Promise<TikTokAgentWorkflowResult> {
    const ctx = toAgentContext(wf);
    const runInput = (wf.input ?? {}) as Record<string, unknown>;

    // The run-scoped brief someone filled in on the portal — the typed
    // direction, the structured intake fields, and any attached media —
    // resolved once, the same way every other agent resolves it.
    const runDirection = readRunDirection(wf.input);

    // ── 00: INTAKE — the client's clip settings, or the defaults ──
    //
    // `forbiddenTopics` comes out of the SAME read as the clip settings, so
    // the terminal guardrail below needs no second one.
    //
    // A client with no `tiktokClips` block used to be refused at intake. That
    // rule protected one decision — which shows the client may clip — and it
    // still does: `sourcePool` defaults to empty, so a client who configured
    // nothing can never have anyone else's footage clipped on their behalf.
    // What they CAN have is an original short, which needs no rights decision
    // at all. A `tiktokClips` block that IS present but does not parse is
    // still a blocked intake: someone wrote settings and got them wrong, and
    // guessing at what they meant is not this agent's call.
    const intakeConfig = await wf.step.code(
      "00-intake",
      async (): Promise<{ config: TikTokClipConfig; forbiddenTopics: string[]; contentPillars: string[]; configured: boolean }> => {
        const outcome = await tools["client.getConfig"]?.execute({}, { ctx });
        const raw = (outcome?.status === "success" ? outcome.result : {}) as Record<string, unknown>;
        const block = raw["tiktokClips"];
        if (block === undefined || block === null) {
          return { config: DEFAULT_CLIP_CONFIG, forbiddenTopics: readForbiddenTopics(raw), contentPillars: readStringList(raw, "contentPillars"), configured: false };
        }
        const parsed = TikTokClipConfigSchema.safeParse(block);
        if (!parsed.success) {
          throw new WorkflowBlockedIntake(`client's tiktokClips config does not parse: ${parsed.error.message}`);
        }
        return { config: parsed.data, forbiddenTopics: readForbiddenTopics(raw), contentPillars: readStringList(raw, "contentPillars"), configured: true };
      },
    );
    const config: TikTokClipConfig = intakeConfig.config;
    const forbiddenTopics: readonly string[] = intakeConfig.forbiddenTopics;

    // ── 00a: who the client is — the discovery step's grounding, and the
    //        script step's sense of what world its b-roll belongs to.
    //        Best-effort: a missing profile narrows what discovery can do, it
    //        does not stop a run that has footage. ──
    const profile = await wf.step.code("00a-read-profile", async (): Promise<{ name?: string; industry?: string; description?: string }> => {
      const outcome = await tools["client.getProfile"]?.execute({}, { ctx });
      const raw = (outcome?.status === "success" ? outcome.result : {}) as Record<string, unknown>;
      const name = readString(raw, "name");
      const industry = readString(raw, "industry");
      const description = readString(raw, "description");
      return { ...(name ? { name } : {}), ...(industry ? { industry } : {}), ...(description ? { description } : {}) };
    });

    // ── 00b: seed the commentary-clip lane from the client's own guest
    // watchlist, before this run's own reservation ever touches it ──
    //
    // `guestWatchlist` is, per this agent's own config contract, "the
    // highest-yield discovery signal", a real name the client themselves gave
    // us. Seeding the catalog from it is exactly as honest as instagram
    // seeding from real research titles, and just as clearly not invention.
    // Never fails the run: no watchlist, or a `topics.topUp` this deployment
    // never registered, degrades to a note.
    //
    // Unconditional every run, with no "is the catalog already healthy" gate:
    // `topics.topUp` is idempotent per normalized topic, so re-seeding is a
    // no-op write once every name is in — and a whole-catalog size check
    // would be the wrong signal regardless, because `catalogSize` counts rows
    // across every lane a client has, keyed only by `clientSlug`, so a client
    // who also runs another channel agent would look "healthy" while THIS
    // lane sits at zero.
    await wf.step.code("00b-seed-catalog", async () => {
      const topUp = tools["topics.topUp"];
      if (topUp === undefined) {
        return { seeded: 0, notes: ["topics.topUp is not registered; nothing to seed the commentary-clip lane with"] };
      }
      if (config.guestWatchlist.length === 0) {
        return { seeded: 0, notes: ["client's guestWatchlist is empty; nothing to seed the commentary-clip lane with from config"] };
      }

      const seeded = await topUp.execute({ topics: config.guestWatchlist, lane: CLIP_LANE }, { ctx });
      if (seeded.status !== "success") {
        return { seeded: 0, notes: [`seeding the commentary-clip lane failed: ${seeded.status}`] };
      }
      const { added, catalogSize } = seeded.result as { added: number; catalogSize: number };
      return { seeded: added, notes: [`${added} new name(s) from the client's guestWatchlist landed in the ${CLIP_LANE} lane (catalog now ${catalogSize} row(s) across all lanes)`] };
    });

    // The anti-repetition read (the excerpt window step 13 writes back into),
    // the client intel report distilled, and what this client asked for on
    // PREVIOUS runs. Read ONCE, up here, because discovery needs the first two
    // as much as drafting does: a scout that cannot see what the client just
    // published proposes it again.
    const outputHistory = await readOutputHistoryForDedup(wf, tools, ctx, "tiktok-agent", "read-output-history");
    const recentPostsDirective = dedupeDirective(outputHistory);
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "read-intel-context");
    const pastFeedback = await readPastFeedback(wf, tools, ctx, "read-past-feedback");

    // Footage the client handed us, in either form the portal and a hand
    // dispatch use. Decided before the topic claim because it changes what an
    // empty catalog MEANS: with footage in hand it is a missing hint, without
    // it is a missing subject.
    const attached = firstAsset(runDirection.mediaAssets, "source");
    const explicitSourcePath = typeof runInput.sourcePath === "string" && runInput.sourcePath.trim().length > 0 ? runInput.sourcePath.trim() : undefined;
    const footageProvided = attached !== undefined || explicitSourcePath !== undefined;

    // ── 01a: "Only media I upload for this job" (RunDirection.mediaSource) ──
    //
    // With footage in hand the user-asset tier below wins and nothing else is
    // touched, exactly as before. Without it there is nothing this run may
    // clip: the owned-footage, web-harvest and generated tiers are all
    // sourcing, and a video has no typographic fallback. Refused here, before
    // the topic claim spends a reservation or a model call.
    await wf.step.code("01a-check-media-source", () => {
      if (runDirection.mediaSource === "client" && !footageProvided) {
        throw new WorkflowBlockedIntake(
          "this run was set to client-provided media only, but no source video was attached — attach the episode to clip, or let the agent find or generate footage",
        );
      }
      return { mediaSource: runDirection.mediaSource, footageProvided };
    });

    interface TopicClaim {
      topic: string;
      topicSource: TopicSource;
      reservationKey?: string;
      discovered?: TopicCandidate;
    }

    /** One catalog reservation attempt. `undefined` is the honest "nothing available" — every other non-success is a tooling failure. */
    const tryReserve = async (): Promise<{ topic: string; reservationKey: string } | undefined> => {
      const tool = tools["topics.reserve"];
      if (!tool) throw new WorkflowToolingFailure(`no tool registered as "topics.reserve"`);
      const outcome = await tool.execute(
        { reservationKey: `${wf.runId}__clip`, count: 1, excludeTopics: config.narrowing, lane: CLIP_LANE },
        { ctx },
      );
      if (outcome.status === "content_fail") return undefined;
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`topics.reserve failed: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
      const result = outcome.result as { reservationKey: string; topics: string[] };
      const topic = result.topics[0];
      if (!topic) return undefined;
      return { topic, reservationKey: result.reservationKey };
    };

    /**
     * 01c/01d — DISCOVERY: what should this client make, when nobody said.
     *
     * Research first, in code, cached and freshness-enforced; then the scout,
     * which may only cite what that research returned; then a dedupe pass
     * against the shipped-output window; then the survivors seed the lane.
     * Every shortfall is a recorded note, and an empty result is an honest
     * outcome the caller turns into a hold — never a fabricated candidate.
     */
    const discoverTopics = async (): Promise<{ candidates: TopicCandidate[]; seeded: number; notes: string[] }> => {
      return wf.step.code("01c-discover-topics", async () => {
        const notes: string[] = [];
        const topUp = tools["topics.topUp"];
        if (topUp === undefined) {
          return { candidates: [], seeded: 0, notes: ["topics.topUp is not registered; discovered topics would have nowhere to land"] };
        }

        interface ResearchDoc {
          title: string;
          url: string;
          description?: string;
          content?: string;
        }
        let researchDocuments: ResearchDoc[] = [];
        const research = tools["research.pull"];
        if (research === undefined) {
          notes.push("research.pull is not registered, so discovery ran on the client's own documents only");
        } else if (profile.industry === undefined) {
          notes.push("client profile declares no industry, so there was no honest research query to run");
        } else {
          const pillars = intakeConfig.contentPillars.slice(0, 4);
          const query = pillars.length > 0 ? `${profile.industry}: ${pillars.join(", ")} — what is being debated this week` : `${profile.industry} news, debates and shifts this week`;
          const pulled = await research.execute(
            { job: "tiktok-topic-discovery", query, window: "24h", maxResults: 8, historyAgentId: "tiktok-agent" },
            { ctx },
          );
          if (pulled.status !== "success") {
            notes.push(`research for discovery was unusable (${pulled.status}${"reason" in pulled ? `: ${pulled.reason}` : ""})`);
          } else {
            const payload = (pulled.result as { result?: { documents?: Array<{ title?: string; url?: string; description?: string; content?: string }> } }).result;
            researchDocuments = (payload?.documents ?? [])
              .filter((d): d is { title: string; url: string; description?: string; content?: string } => typeof d.title === "string" && d.title.trim().length > 0 && typeof d.url === "string" && d.url.length > 0)
              .map((d) => ({
                title: d.title.trim(),
                url: d.url,
                ...(d.description ? { description: d.description.slice(0, 400) } : {}),
                ...(d.content ? { content: d.content.slice(0, 1200) } : {}),
              }));
            notes.push(`research returned ${researchDocuments.length} document(s) for "${query}"`);
          }
        }

        if (researchDocuments.length === 0 && clientIntelContext === undefined) {
          notes.push("no research documents and no client intel — nothing honest to discover topics from");
          return { candidates: [], seeded: 0, notes };
        }

        const scout = new TikTokTopicScoutAgent({ router: options.router, tools, promptStore: options.promptStore });
        const exec = await wf.step.agent("01d-topic-scout", scout, {
          ...runDirectionField(runDirection),
          clientProfile: profile,
          ...(intakeConfig.contentPillars.length > 0 ? { contentPillars: intakeConfig.contentPillars } : {}),
          ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
          researchDocuments,
          ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
          ...(plainSourceNames(config).length > 0 ? { sourcePool: plainSourceNames(config) } : {}),
          mode: config.mode,
        });
        if (exec.status === "content_fail") {
          notes.push("the topic scout did not clear its own output validation");
          return { candidates: [], seeded: 0, notes };
        }
        if (exec.status !== "completed") {
          throw new WorkflowToolingFailure(`topic discovery resolved to "${exec.status}"`);
        }
        const proposed = TopicScoutOutputSchema.parse(exec.finalOutput);

        // The evidence rule, enforced in code: a URL the research did not
        // return is not evidence, whatever the model says it is.
        const knownUrls = new Set(researchDocuments.map((d) => d.url));
        const excluded = new Set(config.narrowing.map(normalizeTopic));
        const candidates: TopicCandidate[] = [];
        let droppedAsRepeats = 0;
        for (const raw of proposed.candidates) {
          const candidate: TopicCandidate = { ...raw, evidenceUrls: raw.evidenceUrls.filter((u) => knownUrls.has(u)) };
          if (excluded.has(normalizeTopic(candidate.topic))) continue;
          // Two reads of "is this a repeat": the fleet's calibrated Jaccard
          // verdict, and a containment check sized for a short candidate
          // against a long caption (see `repeatsPublished`). Either drops it.
          const candidateText = `${candidate.topic}\n${candidate.angle}\n${candidate.hook}`;
          const verdict = evaluateDedupe(candidateText, outputHistory);
          if (verdict.status === "similar" || repeatsPublished(candidateText, outputHistory)) {
            droppedAsRepeats += 1;
            continue;
          }
          candidates.push(candidate);
        }
        if (droppedAsRepeats > 0) notes.push(`${droppedAsRepeats} candidate(s) dropped as too close to what the client recently published`);
        if (candidates.length === 0) {
          notes.push("every proposed candidate was excluded or a repeat");
          return { candidates: [], seeded: 0, notes };
        }

        const seeded = await topUp.execute({ topics: candidates.map((c) => c.topic), lane: CLIP_LANE }, { ctx });
        if (seeded.status !== "success") {
          notes.push(`seeding the lane with discovered topics failed: ${seeded.status}`);
          return { candidates, seeded: 0, notes };
        }
        const { added } = seeded.result as { added: number; catalogSize: number };
        notes.push(`${added} discovered topic(s) landed in the ${CLIP_LANE} lane (${proposed.rationale})`);
        return { candidates, seeded: added, notes };
      });
    };

    // ── 01: claim the topic — the smart order described in the file header ──
    const claim = await wf.step.code("01-claim-topic", async (): Promise<TopicClaim> => {
      // The typed direction wins over the catalog for the same reason an
      // explicit requestedTopic does: a person who wrote a sentence about what
      // they want has more information than the catalog row does. THROUGH THE
      // SHARED PRIMITIVE, not a local read of `customPrompt` — the local
      // version promoted ANY typed sentence to a topic, so "keep it shorter
      // and skip the emoji" became the subject of the clip.
      if (runDirection.topicOverride) return { topic: runDirection.topicOverride, topicSource: "requested" };

      const reserved = await tryReserve();
      if (reserved !== undefined) return { ...reserved, topicSource: "reserved" };

      // The lane is empty. With footage in hand that is a missing HINT, not a
      // missing subject: the moment step names the topic from what the
      // recording actually contains (`topicLabel`).
      if (footageProvided) {
        return { topic: attached?.label ?? "the attached footage", topicSource: "footage" };
      }

      // No direction, no footage, empty lane: go and find out what this
      // client should be talking about.
      const discovery = await discoverTopics();
      if (discovery.seeded > 0 || discovery.candidates.length > 0) {
        const reservedAfterDiscovery = await tryReserve();
        if (reservedAfterDiscovery !== undefined) {
          const match = discovery.candidates.find((c) => normalizeTopic(c.topic) === normalizeTopic(reservedAfterDiscovery.topic));
          return { ...reservedAfterDiscovery, topicSource: "discovered", ...(match ? { discovered: match } : {}) };
        }
      }

      // The legacy loop's rule stands for the case nothing can fill: a run
      // with no candidate "logs that fact and exits cleanly. It never lowers
      // the bar to ship something."
      throw new WorkflowHeld(
        `no ${CLIP_LANE} candidate to make: the catalog lane is empty, no footage was attached, and discovery could not seed it — ${discovery.notes.join("; ")}`,
      );
    });

    // ── 01b: FIND-source — the tiered cascade. Zero-held BETWEEN tiers: a
    //         tier that cannot serve skips to the next with its reason kept,
    //         and only a fully dry cascade holds, naming every tier's outcome. ──
    const intake: TikTokIntake = await wf.step.code("01b-resolve-source", async (): Promise<TikTokIntake> => {
      const tierOutcomes: string[] = [];
      const base = { config, topic: claim.topic, topicSource: claim.topicSource, ...(claim.reservationKey ? { reservationKey: claim.reservationKey } : {}), ...(claim.discovered ? { discovered: claim.discovered } : {}) };

      // Tier 1 — footage attached to THIS run (or a hand-dispatched
      // sourcePath). The attachment is INGESTED rather than passed through:
      // its `uri` is a `gs://` object and `video.transcribe` does a plain
      // readFile on whatever it is handed.
      if (attached) {
        const sourcePath = await ingestSourceVideo(attached, options, tools, wf.runId, ctx);
        return { ...base, sourcePath, sourceTier: "user-asset", sourceContext: { ...(attached.label ? { label: attached.label } : {}), url: attached.uri } };
      }
      if (explicitSourcePath !== undefined) {
        return { ...base, sourcePath: explicitSourcePath, sourceTier: "user-asset" };
      }
      tierOutcomes.push("user-asset: no media attached to this run");

      if (config.mode === "original") {
        tierOutcomes.push("owned-footage, web-harvest: skipped — mode is \"original\", nobody else's footage is used");
      } else {
        // Tier 2a — the client's own footage library: sourcePool entries that
        // are URIs (a podcast episode, a keynote recording in their bucket).
        // The highest-context harvest there is — it's literally their footage.
        const ownedUris = config.sourcePool.filter((entry) => /^(gs|https):\/\//i.test(entry));
        if (ownedUris.length > 0) {
          try {
            const sourcePath = await ingestSourceVideo({ uri: ownedUris[0]!, label: "owned footage" }, options, tools, wf.runId, ctx);
            return { ...base, sourcePath, sourceTier: "owned-footage", sourceContext: { label: "owned footage", url: ownedUris[0]! } };
          } catch (error) {
            tierOutcomes.push(`owned-footage: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          tierOutcomes.push("owned-footage: sourcePool holds no gs://https:// footage URIs");
        }

        // Tier 2b — a web harvest by topic, RESTRICTED to the shows the client
        // holds rights to. A pool that names no shows means this tier has
        // nothing it is allowed to search, and says so rather than searching
        // the open web.
        const harvest = tools["media.harvestVideo"];
        const allowedSources = plainSourceNames(config);
        if (harvest === undefined || options.repoRoot === undefined) {
          tierOutcomes.push("web-harvest: not wired in this deployment");
        } else if (allowedSources.length === 0) {
          tierOutcomes.push("web-harvest: sourcePool names no shows this client may clip, so there is nothing this tier is allowed to search");
        } else {
          const outcome = await harvest.execute({ repoRoot: options.repoRoot, runId: wf.runId, query: claim.topic, allowedSources }, { ctx });
          if (outcome.status === "success") {
            const result = outcome.result as { path: string; sourceUrl: string; title?: string; channel?: string };
            return {
              ...base,
              sourcePath: path.resolve(options.repoRoot, result.path),
              sourceTier: "web-harvest",
              sourceContext: { url: result.sourceUrl, ...(result.title ? { title: result.title } : {}), ...(result.channel ? { channel: result.channel } : {}) },
            };
          }
          tierOutcomes.push(`web-harvest: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
        }
      }

      // Tier 3 — an original short over generated b-roll. The only tier that
      // can answer any topic on demand, and the one `mode: "commentary"`
      // forbids. Nothing is generated HERE: the plates are made per beat once
      // the script exists, because a plate is a scene from a script, not a
      // picture of a topic.
      if (config.mode === "commentary") {
        tierOutcomes.push("generated: disabled — mode is \"commentary\"");
      } else if (tools["video.generateClip"] === undefined || options.repoRoot === undefined) {
        tierOutcomes.push("generated: not wired in this deployment");
      } else {
        return { ...base, sourceTier: "generated" };
      }

      // Every tier dry. A video post has no typographic fallback — this hold
      // is honest, and its reason names exactly what each tier said.
      if (claim.reservationKey) {
        await tools["topics.release"]?.execute({ reservationKey: claim.reservationKey }, { ctx }).catch(() => undefined);
      }
      throw new WorkflowHeld(`no source footage from any tier — ${tierOutcomes.join("; ")}`);
    });

    const format: ClipFormat = intake.sourceTier === "generated" ? "original-short" : "commentary-clip";

    /**
     * Hands a reservation back so a failed run does not burn the topic.
     *
     * Idempotent within a pass. The review cycle below gives this two callers
     * that can fire for the same failure — a drafting step that throws inside
     * `attempt`, and the catch wrapping the cycle — and `topics.release` is
     * not a no-op the second time: it puts the row back for anyone to claim
     * and records a second release against a reservation that only ever
     * existed once.
     */
    let reservationReleased = false;
    const releaseReservation = async (): Promise<void> => {
      if (!intake.reservationKey || reservationReleased) return;
      const tool = tools["topics.release"];
      if (!tool) return;
      reservationReleased = true;
      await tool.execute({ reservationKey: intake.reservationKey }, { ctx }).catch(() => undefined);
    };

    /** The cut plan every downstream step works from — real transcript-derived bounds for spoken footage, or nothing for a generated short. */
    interface ClipPlan {
      startSeconds: number;
      endSeconds: number;
      words: TranscriptWordLike[];
      text: string;
      /** Whether a cut is needed at all — a generated short is assembled, not cut. */
      needsCut: boolean;
    }

    // The run's topic. Provisional for `topicSource: "footage"` until the
    // moment step names what the recording is actually about.
    let topic = intake.topic;
    let moment: MomentSelection;
    let bounds: ClipPlan;

    if (intake.sourceTier === "generated") {
      // A generated short has no speech to mine and no moment to pick. The
      // script step (inside `produceClip`, so a reviewer's note can rewrite
      // it) carries the whole message; this placeholder keeps the deliverable
      // shape every consumer already reads.
      moment = await wf.step.code("03-select-moment", () => ({
        startSeconds: 0,
        endSeconds: CLIP_DURATION_MIN_SECONDS,
        hookLine: intake.topic,
        hookType: "sharp-one-liner" as const,
        rationale: "original short — no transcript exists to pick a moment from; the script carries the message over generated b-roll",
      }));
      bounds = { startSeconds: 0, endSeconds: 0, words: [], text: "", needsCut: false };
    } else {
      // ── 02: transcript ──
      const words: TranscriptWordLike[] = await wf.step.code("02-transcribe", async () => {
        const result = (await callTool(tools, "video.transcribe", { videoPath: intake.sourcePath }, ctx)) as {
          words?: TranscriptWordLike[];
        };
        const spoken = (result.words ?? []).filter((w) => typeof w.text === "string" && w.text.trim().length > 0);
        if (spoken.length === 0) {
          await releaseReservation();
          // Non-verbal source. The legacy loop falls back to a retention heatmap
          // here; this engine has no heatmap tool, so the honest outcome is to
          // stop rather than to guess a moment out of a silent timeline.
          throw new WorkflowHeld("the source has no spoken words to clip, and this deployment has no retention-heatmap fallback");
        }
        return spoken;
      });

      // ── 03: PICK-moment (judgment) ──
      moment = await wf.step.code("03-select-moment", async () => {
        const agent = new TikTokMomentAgent({ router: options.router, tools, promptStore: options.promptStore });
        const exec = await wf.step.agent("03a-moment", agent, {
          // Which moment to clip is exactly the kind of thing a client's
          // direction speaks to ("the part where they talk about pricing"),
          // and the topic alone cannot carry a style note or an audience.
          ...runDirectionField(runDirection),
          topic: intake.topic,
          // Tells the picker how much weight the topic carries: a reserved
          // guest name is a steer, "the attached footage" is no steer at all.
          topicSource: intake.topicSource,
          ...(intake.sourceContext ? { sourceContext: intake.sourceContext } : {}),
          transcript: sentenceBoundedWords(words),
          durationMin: CLIP_DURATION_MIN_SECONDS,
          durationMax: CLIP_DURATION_MAX_SECONDS,
        });
        if (exec.status === "content_fail") {
          await releaseReservation();
          throw new WorkflowHeld("moment selection did not clear its own output validation");
        }
        if (exec.status !== "completed") {
          await releaseReservation();
          throw new WorkflowToolingFailure(`moment selection resolved to "${exec.status}"`);
        }
        return MomentSelectionSchema.parse(exec.finalOutput);
      });
      if (intake.topicSource === "footage" && moment.topicLabel) topic = moment.topicLabel;

      // ── 04: CUT — snap to real transcript boundaries and validate. This is
      //        the whole cut gate: the deterministic TS bounds check below is
      //        the check that actually runs and holds. ──
      const cut = await wf.step.code("04-cut-bounds", async () => {
        // The model's timestamps are a proposal. This is where they become real:
        // snapped to actual word boundaries in the transcript, then checked
        // against the length rule. A model asked for a timestamp will return one
        // whether or not the transcript supports it.
        const result = boundsFromTranscript(words, moment.startSeconds, moment.endSeconds, {
          minSeconds: CLIP_DURATION_MIN_SECONDS,
          maxSeconds: CLIP_DURATION_MAX_SECONDS,
        });
        if (!result.ok) {
          await releaseReservation();
          throw new WorkflowHeld(`selected moment is not clippable: ${result.reason}`);
        }
        return result;
      });
      bounds = { startSeconds: cut.startSeconds, endSeconds: cut.endSeconds, words: cut.words, text: cut.text, needsCut: true };
    }

    // ── 07b: the client's brand, for the framed clip. Best-effort, never
    //         blocking — brand furniture must never be able to hold a run,
    //         the same rule the slide pipeline's brand kit follows.
    //
    //         Read ONCE, above the review cycle: a reviewer's note changes the
    //         words, never the client's own colours, so every revision's
    //         render reuses this rather than re-reading it. ──
    const baseWorkDir = path.join(os.tmpdir(), "tiktok-agent", wf.runId);
    const videoBrand = await wf.step.code("07b-load-video-brand", async (): Promise<VideoBrand> => {
      const HEX6 = /^#[0-9a-fA-F]{6}$/;
      const asHex = (v: unknown): string | undefined => (typeof v === "string" && HEX6.test(v.trim()) ? v.trim() : undefined);
      const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
      const brand = (brandOutcome?.status === "success" ? brandOutcome.result : {}) as Record<string, unknown>;
      const colors = (brand["colors"] ?? {}) as Record<string, unknown>;
      const rawHandle = typeof brand["handle"] === "string" ? brand["handle"].trim() : "";
      const logoUrl = typeof brand["logoUrl"] === "string" && /^https:\/\//i.test(brand["logoUrl"]) ? brand["logoUrl"] : undefined;
      const language = readString(brand, "language");
      return {
        ground: asHex(colors["neutralDark"]) ?? "#17181C",
        fg: asHex(colors["neutralLight"]) ?? "#F4F2EC",
        ...(asHex(brand["accent"]) ?? asHex(colors["primaryAccent"])
          ? { accent: (asHex(brand["accent"]) ?? asHex(colors["primaryAccent"]))! }
          : {}),
        ...(rawHandle.length > 0 && /^@?[A-Za-z0-9._]{1,40}$/.test(rawHandle) ? { handle: `@${rawHandle.replace(/^@+/, "")}` } : {}),
        ...(config.seriesHeader !== undefined ? { seriesHeader: config.seriesHeader } : {}),
        ...(logoUrl !== undefined ? { logoUrl } : {}),
        ...(language !== undefined ? { language } : {}),
      };
    });

    /**
     * The logo, downloaded fresh for a render (any failure = no logo, never a
     * hold), with the WCAG contrast plan the compositor needs.
     *
     * AU38 (SCRUM-322): the cover's top bar is painted in `videoBrand.ground`,
     * so the mark's own decoded colors are checked against THAT token before
     * it is composited. A mark that clears WCAG 3:1 overlays bare; one that
     * does not gets the plate the plan verified it does clear; and a mark
     * whose bytes are unreadable is reported unchecked rather than credited
     * with a contrast nobody computed. No prompt is involved in any of it.
     */
    const prepareLogo = async (workDir: string): Promise<{ logoPath?: string; logoScrim?: string }> => {
      if (videoBrand.logoUrl === undefined) return {};
      const download = await downloadBrandLogo(options.fetchImpl ?? fetch, videoBrand.logoUrl);
      // SVG can't overlay in ffmpeg without a rasterizer — raster formats only here.
      if (download === undefined || download.mime === "image/svg+xml") return {};
      const ink = readBrandLogoInk(download);
      const placement = planBrandLogoPlacement({
        ground: videoBrand.ground,
        ...(ink !== undefined ? { ink } : {}),
        fg: videoBrand.fg,
        surface: "cover",
      });
      if (placement.decision === "omit") return {};
      const logoPath = path.join(workDir, download.mime === "image/png" ? "logo.png" : "logo.jpg");
      await fs.writeFile(logoPath, download.bytes);
      return { logoPath, ...(placement.scrim?.color !== undefined ? { logoScrim: placement.scrim.color } : {}) };
    };

    /** The branded 9:16 frame around a finished cut or sequence — bars, header, handle, logo, captions. */
    const brandFrame = async (clipPath: string, workDir: string, srtPath: string | undefined): Promise<{ outputPath: string; durationSeconds: number | null }> => {
      const { logoPath, logoScrim } = await prepareLogo(workDir);
      const frameOutcome = await tools["video.brandFrame"]?.execute(
        {
          videoPath: clipPath,
          outputPath: path.join(workDir, "clip-framed.mp4"),
          brand: {
            ground: videoBrand.ground,
            fg: videoBrand.fg,
            ...(videoBrand.accent !== undefined ? { accent: videoBrand.accent } : {}),
            ...(videoBrand.handle !== undefined ? { handle: videoBrand.handle } : {}),
            ...(videoBrand.seriesHeader !== undefined ? { seriesHeader: videoBrand.seriesHeader } : {}),
            ...(logoPath !== undefined ? { logoPath } : {}),
            ...(logoPath !== undefined && logoScrim !== undefined ? { logoScrim } : {}),
          },
          ...(srtPath !== undefined ? { srtPath } : {}),
        },
        { ctx },
      );
      if (frameOutcome === undefined || frameOutcome.status !== "success") {
        throw new WorkflowToolingFailure(
          `video.brandFrame failed: ${frameOutcome === undefined ? "tool not registered" : `${frameOutcome.status}${"reason" in frameOutcome ? ` (${frameOutcome.reason})` : ""}`}`,
        );
      }
      const framed = frameOutcome.result as { outputPath: string; durationSeconds: number | null };
      return { outputPath: framed.outputPath, durationSeconds: framed.durationSeconds ?? null };
    };

    /** One round's finished clip: what the gate shows a reviewer, and what step 12 persists once one approves it. */
    interface ClipDraft {
      /** Named `commentary` for both formats: it is the field the persisted review-feedback row (SCRUM-306) and the portal read. */
      commentary: ClipCopy;
      script?: ShortScript;
      voiceover: boolean;
      renderedPath: string;
      durationSeconds: number;
      uploaded: { gcsUri: string; signedUrl?: string } | null;
      /** The hook a viewer meets first — the moment's line, or the script's. */
      hookLine: string;
    }

    /**
     * The text-level dedupe loop around ONE drafting call. `draft` runs the
     * model; the scored text is exactly what 07-compliance checks and
     * 13-commit-and-record writes back into the window, so every future run
     * compares like with like. On a `similar` verdict the draft is redone with
     * the offending post quoted into the prompt, bounded by
     * `MAX_DEDUPE_ATTEMPTS`; on the final attempt it ships FLAGGED rather than
     * held — the verdict stays checkpointed either way, and the human at
     * 11-clip-review is never shown words that were not scored.
     */
    const draftWithVerifiedDedupe = async <T>(
      rev: (id: string) => string,
      draftStepId: string,
      verifyStepId: string,
      draft: (attemptStepId: string, dedupeAvoid: string | undefined) => Promise<T>,
      scoredText: (draft: T) => string,
    ): Promise<T> => {
      let dedupeRetrySteer: string | undefined;
      for (let attempt = 1; attempt <= MAX_DEDUPE_ATTEMPTS; attempt++) {
        /** Attempt 1 keeps the ORIGINAL step ids, so a run that never repeats itself has a byte-identical trace to what it had before this check existed. */
        const att = (id: string) => (attempt === 1 ? id : `${id}-attempt-${attempt}`);
        const drafted = await draft(rev(att(draftStepId)), dedupeRetrySteer);
        const verdict = await checkOutputDedupe(wf, rev(att(verifyStepId)), scoredText(drafted), outputHistory);
        if (verdict.status === "similar" && attempt < MAX_DEDUPE_ATTEMPTS) {
          dedupeRetrySteer = dedupeRetryDirective(verdict, outputHistory);
          continue;
        }
        return drafted;
      }
      // Unreachable: the loop's last attempt always returns, because the
      // `continue` above is guarded on `attempt < MAX_DEDUPE_ATTEMPTS`.
      throw new WorkflowToolingFailure("the de-duplication redraft loop ended without a draft");
    };

    /** The deterministic text gates every caption clears before anything is rendered. */
    const runTextGates = async (text: string): Promise<void> => {
      for (const [gate, args] of [
        ["gate.lintPost", { text }],
        ["gate.brandCompliance", { text }],
        ["gate.noPlaceholder", { text }],
        ["gate.leakCheck", { text }],
      ] as const) {
        const verdict = await runGate(tools, gate, args, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`${gate}: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") {
          throw new WorkflowHeld(`${gate} failed: ${verdict.reason}`);
        }
      }
    };

    // ─────────────────────────────────────────────────────────────────────
    // The COMMENTARY-CLIP production pass: someone else's moment, the
    // client's take, cut + captioned + framed.
    // ─────────────────────────────────────────────────────────────────────
    const produceCommentaryClip = async (revision: number, notes: readonly RevisionNote[]): Promise<ClipDraft> => {
      /** Revision 0 keeps the ORIGINAL ids, so a first-pass trace is unchanged. */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);
      // A later round renders into its own directory. Sharing one would
      // overwrite `clip-framed.mp4` in place, and the r0 gate record — the
      // audit trail of what a human actually looked at — would then point at a
      // file holding the r1 clip.
      const workDir = revision === 0 ? baseWorkDir : path.join(baseWorkDir, `r${revision}`);

      // ── 06/06b: COMPOSE the commentary layer (judgment), then VERIFY it is
      //           not a repeat before anything downstream sees it ──
      const commentary = await draftWithVerifiedDedupe<Commentary>(
        rev,
        "06-commentary",
        "06b-verify-not-duplicate",
        (stepId, dedupeAvoid) =>
          wf.step.code(stepId, async () => {
            const agent = new TikTokCommentaryAgent({ router: options.router, tools, promptStore: options.promptStore });
            const exec = await wf.step.agent(`${stepId.replace("06-commentary", "06a-commentary")}`, agent, {
              // The step that writes the caption the client reads — the one
              // place their direction and brief matter most.
              ...runDirectionField(runDirection),
              topic,
              hookLine: moment.hookLine,
              hookType: moment.hookType,
              clipText: bounds.text,
              // What the footage ACTUALLY is, so the credit names it rather
              // than a plausible episode.
              ...(intake.sourceContext ? { sourceContext: intake.sourceContext } : {}),
              ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
              ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
              ...(dedupeAvoid !== undefined ? { dedupeAvoid } : {}),
              // Two distinct steers, kept apart: `pastFeedback` is what this client
              // has said across previous RUNS, `revisionRequest` is what a reviewer
              // asked about THIS clip minutes ago.
              ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
              ...(directive !== undefined ? { revisionRequest: directive } : {}),
            });
            if (exec.status === "content_fail") {
              throw new WorkflowHeld("commentary did not clear its own output validation");
            }
            if (exec.status !== "completed") {
              throw new WorkflowToolingFailure(`commentary step resolved to "${exec.status}"`);
            }
            // The one mechanical tell repaired in code before anything scores
            // or gates the text (see `normalizeBannedDashes`): the agent has
            // already self-critiqued against the lint gate, this is the
            // backstop that makes a stray dash a comma instead of a held run.
            return normalizeCommentaryDashes(exec.finalOutput as Commentary);
          }),
        (c) => `${c.caption}\n\n${c.about}`,
      );

      // ── 07: compliance pass ──
      await wf.step.code(rev("07-compliance"), async () => {
        // Source credit first, and checked in code rather than asked of the
        // model that wrote it. The legacy rule is explicit that the on-clip
        // attribution block is not enough — the caption has to name it — and a
        // clip that ships uncredited is the one failure here with a party
        // outside this system.
        if (!commentary.caption.includes(commentary.sourceCredit)) {
          throw new WorkflowHeld("the caption does not carry the source credit, and an on-clip attribution block alone is not enough");
        }
        await runTextGates(`${commentary.caption}\n\n${commentary.about}`);
      });

      // ── 08: render — cut, caption, branded frame, all pure ffmpeg. ──
      const rendered = await wf.step.code(rev("08-render"), async (): Promise<{ outputPath: string; durationSeconds: number | null }> => {
        await fs.mkdir(workDir, { recursive: true });

        // Cut the moment out of the source.
        let clipPath = intake.sourcePath!;
        if (bounds.needsCut) {
          const cutOutcome = await tools["video.cutClip"]?.execute(
            {
              sourcePath: intake.sourcePath,
              startSeconds: bounds.startSeconds,
              endSeconds: bounds.endSeconds,
              outputPath: path.join(workDir, "clip-cut.mp4"),
            },
            { ctx },
          );
          if (cutOutcome === undefined || cutOutcome.status !== "success") {
            throw new WorkflowToolingFailure(
              `video.cutClip failed: ${cutOutcome === undefined ? "tool not registered" : `${cutOutcome.status}${"reason" in cutOutcome ? ` (${cutOutcome.reason})` : ""}`}`,
            );
          }
          clipPath = (cutOutcome.result as { outputPath: string }).outputPath;
        }

        // Burned captions, from the moment's own word timings — clip-relative.
        let srtPath: string | undefined;
        if (bounds.words.length > 0) {
          const srt = buildSrt(
            bounds.words.map((w) => ({ word: w.text, start: w.start, end: w.end })),
            bounds.startSeconds,
          );
          srtPath = path.join(workDir, "captions.srt");
          await fs.writeFile(srtPath, srt, "utf8");
        }

        return brandFrame(clipPath, workDir, srtPath);
      });

      return finishDraft(rev, revision, {
        commentary: { caption: commentary.caption, about: commentary.about, sourceCredit: commentary.sourceCredit },
        voiceover: false,
        renderedPath: rendered.outputPath,
        // The framed file's probed length is the truth; the transcript-derived
        // window is the fallback.
        durationSeconds: rendered.durationSeconds ?? bounds.endSeconds - bounds.startSeconds,
        hookLine: moment.hookLine,
        guardrailText: `${commentary.caption}\n\n${commentary.about}\n\n${bounds.text}`,
        captionsExpected: bounds.words.length > 0,
      });
    };

    // ─────────────────────────────────────────────────────────────────────
    // The ORIGINAL-SHORT production pass: a script, generated plates per
    // beat, an optional voice, captions from real word timings, framed.
    // ─────────────────────────────────────────────────────────────────────
    const produceOriginalShort = async (revision: number, notes: readonly RevisionNote[]): Promise<ClipDraft> => {
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);
      const workDir = revision === 0 ? baseWorkDir : path.join(baseWorkDir, `r${revision}`);
      const repoRoot = options.repoRoot!;

      // ── 03s: SCRIPT (judgment) — then the same verified dedupe the
      //         commentary layer gets, on the caption + about that ship ──
      const script = await draftWithVerifiedDedupe<ShortScript>(
        rev,
        "03s-script",
        "03t-verify-not-duplicate",
        (stepId, dedupeAvoid) =>
          wf.step.code(stepId, async () => {
            const agent = new TikTokScriptAgent({ router: options.router, tools, promptStore: options.promptStore });
            const exec = await wf.step.agent(stepId.replace("03s-script", "03u-script"), agent, {
              ...runDirectionField(runDirection),
              topic,
              ...(intake.discovered ? { topicBrief: intake.discovered } : {}),
              clientProfile: profile,
              ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
              ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
              ...(dedupeAvoid !== undefined ? { dedupeAvoid } : {}),
              ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
              ...(directive !== undefined ? { revisionRequest: directive } : {}),
              voiceoverPolicy: config.voiceover,
              allowPeople: config.allowPeopleInGeneratedFootage,
              ...(config.voiceLanguage ?? videoBrand.language ? { contentLanguage: config.voiceLanguage ?? videoBrand.language } : {}),
            });
            if (exec.status === "content_fail") {
              throw new WorkflowHeld("the script did not clear its own output validation");
            }
            if (exec.status !== "completed") {
              throw new WorkflowToolingFailure(`script step resolved to "${exec.status}"`);
            }
            return normalizeScriptDashes(ShortScriptSchema.parse(exec.finalOutput));
          }),
        (s) => `${s.caption}\n\n${s.about}`,
      );
      // The client's config outranks the model's per-piece call; on `auto`
      // the model decided and said why.
      const voiceover = config.voiceover === "always" ? true : config.voiceover === "never" ? false : script.voiceover;

      // ── 07: compliance pass — the caption and about, plus every line the
      //        viewer will hear or read, because on-screen words are
      //        published words too ──
      await wf.step.code(rev("07-compliance"), async () => {
        await runTextGates([script.caption, script.about, ...script.beats.flatMap((b) => [b.narration, b.onScreenText])].join("\n\n"));
      });

      // ── 04p: GENERATE the plates, one per beat. Step ids carry NO revision
      //         suffix on purpose: a reviewer's note changes the words, and
      //         footage already made for beat 3 is reused for the revised
      //         beat 3 rather than paid for again. A revision with MORE beats
      //         generates only the extra ones; one with fewer uses a subset.
      //         Footage nobody asked to change is the one expensive thing
      //         here, and a `reject` (a fresh run) is the path to new footage. ──
      const plates: string[] = [];
      for (let i = 0; i < script.beats.length; i++) {
        const beat = script.beats[i]!;
        const plate = await wf.step.code(`04p-plate-${i + 1}`, async (): Promise<string> => {
          const generate = tools["video.generateClip"]!;
          const request = {
            repoRoot,
            runId: wf.runId,
            brief: beat.visualBrief,
            durationSeconds: beat.seconds,
            aspectRatio: "9:16" as const,
            outputName: `plate-${i + 1}`,
            allowPeople: config.allowPeopleInGeneratedFootage,
          };
          let outcome = await generate.execute(request, { ctx });
          if (outcome.status === "content_fail") {
            // A declined scene gets ONE plainer retake before the run gives up
            // on it — the model refused the picture, not the topic.
            outcome = await generate.execute(
              { ...request, brief: `${beat.visualBrief}. Wide establishing shot, no people, calm natural light.`, allowPeople: false },
              { ctx },
            );
          }
          if (outcome.status !== "success") {
            throw new WorkflowHeld(`b-roll for beat ${i + 1} could not be generated (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})`);
          }
          return path.resolve(repoRoot, (outcome.result as { path: string }).path);
        });
        plates.push(plate);
      }

      // ── 05: VOICE — the narration spoken, then TIMED by transcribing the
      //        very file that will play, so captions sit on the words a
      //        listener actually hears rather than on an estimate. ──
      const narration = script.beats.map((b) => b.narration.trim()).join(" … ");
      const language = config.voiceLanguage ?? videoBrand.language ?? script.language;
      const voice = await wf.step.code(rev("05-voiceover"), async (): Promise<{ path: string; durationSeconds: number | null; words: TranscriptWordLike[]; notes: string[] } | null> => {
        if (!voiceover) return null;
        await fs.mkdir(workDir, { recursive: true });
        const synth = tools["video.synthesizeVoice"];
        if (synth === undefined) {
          throw new WorkflowToolingFailure("this piece wants a voiceover but video.synthesizeVoice is not registered — set the client's voiceover to \"never\" or wire a TTS provider");
        }
        const outputPath = path.join(workDir, "voiceover.mp3");
        const outcome = await synth.execute(
          { text: narration, outputPath, language, ...(config.voiceName ? { voice: config.voiceName } : {}) },
          { ctx },
        );
        if (outcome.status !== "success") {
          throw new WorkflowToolingFailure(`video.synthesizeVoice failed: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
        }
        const result = outcome.result as { outputPath: string; durationSeconds: number | null };
        const notes: string[] = [];
        let words: TranscriptWordLike[] = [];
        const timing = await tools["video.transcribe"]?.execute({ videoPath: result.outputPath }, { ctx });
        if (timing?.status === "success") {
          words = ((timing.result as { words?: TranscriptWordLike[] }).words ?? []).filter((w) => typeof w.text === "string" && w.text.trim().length > 0);
        } else {
          notes.push(`voiceover word timings unavailable (${timing?.status ?? "video.transcribe not registered"}); captions are timed per beat instead`);
        }
        return { path: result.outputPath, durationSeconds: result.durationSeconds, words, notes };
      });

      // ── 08: render — hold each plate for its beat, lay the voice under,
      //        burn the captions, frame it. ──
      const rendered = await wf.step.code(rev("08-render"), async (): Promise<{ outputPath: string; durationSeconds: number | null }> => {
        await fs.mkdir(workDir, { recursive: true });

        // How long each beat holds. With a voice, the plates stretch to cover
        // it in proportion to how much each beat says; without one, the
        // script's own seconds stand.
        const scripted = script.beats.map((b) => b.seconds);
        let holds: number[] = scripted;
        if (voice?.durationSeconds) {
          const wordCounts = script.beats.map((b) => Math.max(1, b.narration.trim().split(/\s+/).length));
          const totalWords = wordCounts.reduce((a, b) => a + b, 0);
          const total = voice.durationSeconds + 0.4;
          holds = wordCounts.map((n) => Math.max(MIN_PLATE_HOLD_SECONDS, (n / totalWords) * total));
        }
        const boundaries = holds.reduce<number[]>((acc, h) => [...acc, (acc[acc.length - 1] ?? 0) + h], []);

        // Captions: from the voice's real word timings when we have them,
        // else the on-screen text per beat, held for the beat.
        const cues =
          voice && voice.words.length > 0
            ? buildSrt(
                voice.words.map((w) => ({ word: w.text, start: w.start, end: w.end })),
                0,
                3,
              )
            : buildSrt(
                script.beats.map((b, i) => ({ word: b.onScreenText, start: i === 0 ? 0 : boundaries[i - 1]!, end: boundaries[i]! - 0.05 })),
                0,
                1,
              );
        const srtPath = path.join(workDir, "captions.srt");
        await fs.writeFile(srtPath, cues, "utf8");

        const compose = tools["video.composeSequence"];
        if (compose === undefined) throw new WorkflowToolingFailure("video.composeSequence is not registered — an original short cannot be assembled");
        const composed = await compose.execute(
          {
            clips: plates.slice(0, script.beats.length).map((p, i) => ({ path: p, holdSeconds: Number(holds[i]!.toFixed(2)) })),
            outputPath: path.join(workDir, "sequence.mp4"),
            ...(voice ? { voiceoverPath: voice.path } : {}),
          },
          { ctx },
        );
        if (composed.status !== "success") {
          throw new WorkflowToolingFailure(`video.composeSequence failed: ${composed.status}${"reason" in composed ? ` (${composed.reason})` : ""}`);
        }
        const sequence = composed.result as { outputPath: string; durationSeconds: number | null };

        return brandFrame(sequence.outputPath, workDir, srtPath);
      });

      return finishDraft(rev, revision, {
        commentary: { caption: script.caption, about: script.about },
        script,
        voiceover,
        renderedPath: rendered.outputPath,
        durationSeconds: rendered.durationSeconds ?? script.beats.reduce((a, b) => a + b.seconds, 0),
        hookLine: script.hook,
        guardrailText: [script.caption, script.about, ...script.beats.map((b) => b.narration)].join("\n\n"),
        captionsExpected: true,
      });
    };

    /**
     * What both production passes share once a framed file exists: the
     * blocking QA gates, the reviewer's upload, and the terminal topic
     * guardrail.
     */
    const finishDraft = async (
      rev: (id: string) => string,
      revision: number,
      draft: Omit<ClipDraft, "uploaded"> & { guardrailText: string; captionsExpected: boolean },
    ): Promise<ClipDraft> => {
      const { renderedPath } = draft;

      await wf.step.code(rev("09-qa-gate"), async () => {
        // Blocking. The legacy rule: "Any failure aborts THIS candidate (never
        // ship degraded)." The bitstream check is the one deterministic QA the
        // file itself can answer.
        const verdict = await runGate(tools, "video.selfEvalGate", { videoPath: renderedPath }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.selfEvalGate: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") {
          throw new WorkflowHeld(`video.selfEvalGate failed: ${verdict.reason}`);
        }
      });

      // ── 10a: upload BEFORE the human gate, so the reviewer can actually
      //         watch what they're approving (a bare container path is not a
      //         reviewable clip). Registered only when a media store is
      //         configured; absent, the gate carries the local path as before.
      //         Also before the visual QA, which can then watch the GCS object
      //         instead of pushing the whole file inline. ──
      const uploaded = await wf.step.code(rev("10a-upload-clip"), async () => {
        const uploadTool = tools["video.uploadDeliverable"];
        if (!uploadTool) return null;
        // Revision-suffixed for the same reason the work directory is: a
        // revision must not overwrite the object the previous round's gate
        // record links a reviewer to.
        const objectName = revision === 0 ? "clip.mp4" : `clip-r${revision}.mp4`;
        const outcome = await uploadTool.execute(
          { localPath: renderedPath, objectPath: `tiktok/${wf.clientSlug}/${wf.runId}/${objectName}`, contentType: "video/mp4" },
          { ctx },
        );
        if (outcome.status !== "success") {
          console.error(`${rev("10a-upload-clip")}: upload failed (${outcome.status}) — the gate and deliverable carry the local path only`);
          return null;
        }
        return outcome.result as { gcsUri: string; signedUrl?: string };
      });

      // ── 10b: the visual QA — a model WATCHES the finished clip and says
      //         whether a person would post it: captions legible and in sync,
      //         no generation artifacts, the brand frame intact, and whether
      //         it reads as generated. Blocking on content_fail; a deployment
      //         without the gate records that it was skipped rather than
      //         pretending it passed. ──
      await wf.step.code(rev("10b-visual-qa"), async () => {
        const gate = tools["video.visualQaGate"];
        if (gate === undefined) return { skipped: true, note: "video.visualQaGate is not registered in this deployment" };
        const outcome = await gate.execute(
          {
            videoPath: renderedPath,
            ...(uploaded?.gcsUri ? { gcsUri: uploaded.gcsUri } : {}),
            expectations: {
              topic,
              hookLine: draft.hookLine,
              captionsExpected: draft.captionsExpected,
              voiceoverExpected: draft.voiceover,
              brandColors: [videoBrand.ground, videoBrand.fg, ...(videoBrand.accent ? [videoBrand.accent] : [])],
              ...(videoBrand.language ? { language: videoBrand.language } : {}),
              format,
            },
          },
          { ctx },
        );
        if (outcome.status === "not_available") return { skipped: true, note: `video.visualQaGate is not available: ${outcome.reason}` };
        if (outcome.status !== "success") throw new WorkflowToolingFailure(`video.visualQaGate: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
        const verdict = outcome.result as GateVerdict;
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.visualQaGate: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`video.visualQaGate failed: ${verdict.reason}`);
        return { skipped: false, evidence: verdict.evidence };
      });

      // ── 10: terminal topic guardrail ──
      //
      // The same check the dynamic runner appends to every dynamic agent, run
      // here for the same reason: the client's own forbidden-topic list is a
      // promise about what their account will not talk about, and a clip of
      // someone ELSE saying it is still their account saying it. Runs before the
      // human gate so a reviewer is never shown something that should not exist.
      //
      // `forbiddenTopics` is what step 00 already read, so the guardrail does
      // not read the client's config a second time. The `-r{n}` suffix gives
      // each revision round its own checkpoint: without it the fixed step id
      // short-circuits on round 0's checkpoint and the REVISED words are never
      // actually verified, while the trace still reports a pass.
      await runTopicGuardrail(
        wf,
        { tools, promptStore: options.promptStore, router: options.router },
        draft.guardrailText,
        forbiddenTopics,
        revision === 0 ? undefined : `-r${revision}`,
      );

      return {
        commentary: draft.commentary,
        ...(draft.script ? { script: draft.script } : {}),
        voiceover: draft.voiceover,
        renderedPath,
        durationSeconds: draft.durationSeconds,
        uploaded,
        hookLine: draft.hookLine,
      };
    };

    const produceClip = format === "original-short" ? produceOriginalShort : produceCommentaryClip;

    // ── 11: the universal approve / revise / reject cycle ──
    //
    // `revise` re-writes the words with the reviewer's feedback in hand and
    // re-renders the clip around them, reusing everything already
    // checkpointed, instead of holding the run and forcing somebody to
    // dispatch a fresh one that knows nothing about why the first was turned
    // down. Every decision, approvals included, is written to client memory.
    const review = await runReviewCycle<ClipDraft>(wf, {
      gateId: "11-clip-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: produceClip,
      buildGate: (draft, revision) => ({
        kind: "batch_review",
        payload: {
          runId: wf.runId,
          topic,
          topicSource: intake.topicSource,
          lane: CLIP_LANE,
          format,
          preview: draft.commentary.caption,
          clipPath: draft.renderedPath,
          durationSeconds: draft.durationSeconds,
          sourceTier: intake.sourceTier,
          voiceover: draft.voiceover,
          ...(draft.script ? { script: draft.script } : {}),
          revision,
          // The reviewer's actual preview — a signed URL they can watch.
          ...(draft.uploaded?.signedUrl !== undefined ? { videoUrl: draft.uploaded.signedUrl } : {}),
          ...(draft.uploaded !== null ? { gcsUri: draft.uploaded.gcsUri } : {}),
        },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "hold" },
      }),
      onDecision: async ({ revision, response, output }) => {
        // SCRUM-306 (AU23): a reject's drafted content previously had nowhere
        // durable to go — it lived only in this round's step checkpoints and
        // was lost the moment the run held. Attached only on reject: an
        // approval's content already has a durable copy via
        // `ledger.writeDeliverable`, and a revise round's draft is superseded
        // by the next attempt.
        await persistReviewFeedbackToMemory(
          wf,
          tools,
          ctx,
          revision,
          response,
          response.decision === "reject" ? JSON.stringify(output) : undefined,
        );
      },
    }).catch(async (error: unknown): Promise<never> => {
      // The topic goes back for anything that ends this run without a clip: a
      // rejection, the revision ceiling, a content gate that said no inside
      // the production pass, a guardrail violation.
      //
      // Every such failure releases here and ONLY here — but a gate nobody has
      // answered yet is not one of them. `step.gate` throws
      // `AwaitingGateSignal` to PAUSE the run; that is the literal "throw to
      // pause" contract `WorkflowEngine.run` catches to return
      // `awaiting_gate`, and it arrives at this catch on every single run that
      // actually waits for a human. Releasing on it would hand the topic back
      // the instant the clip reached a reviewer: the row returns to the lane
      // while the clip made from it sits awaiting approval, the next run
      // claims the same topic, and the approval that eventually lands commits
      // a reservation that no longer means anything.
      if (error instanceof AwaitingGateSignal) throw error;
      await releaseReservation();
      throw error;
    });
    const { commentary: copy, script, voiceover, renderedPath, durationSeconds, uploaded } = review.output;

    // ── 12: QUEUE ──
    const deliverableId: string = await wf.step.code("12-persist-deliverable", async () => {
      const result = (await callTool(
        tools,
        "ledger.writeDeliverable",
        {
          runId: wf.runId,
          kind: "tiktok-clip",
          deliverable: {
            topic,
            topicSource: intake.topicSource,
            lane: CLIP_LANE,
            format,
            clipPath: renderedPath,
            caption: copy.caption,
            about: copy.about,
            ...(copy.sourceCredit !== undefined ? { sourceCredit: copy.sourceCredit } : {}),
            ...(intake.sourceContext ? { sourceContext: intake.sourceContext } : {}),
            hookLine: review.output.hookLine,
            hookType: moment.hookType,
            startSeconds: bounds.startSeconds,
            endSeconds: bounds.endSeconds,
            durationSeconds,
            sourceTier: intake.sourceTier,
            voiceover,
            ...(script ? { script } : {}),
            ...(uploaded?.signedUrl !== undefined ? { signedUrl: uploaded.signedUrl } : {}),
            ...(uploaded !== null ? { gcsUri: uploaded.gcsUri } : {}),
          },
        },
        ctx,
      )) as { id: string };
      return result.id;
    });

    // ── 13: LOG — burn the topic only now that a clip actually shipped ──
    await wf.step.code("13-commit-and-record", async () => {
      if (intake.reservationKey) {
        await callTool(tools, "topics.commit", { reservationKey: intake.reservationKey }, ctx);
      }
      // The write half of the anti-repetition loop — best-effort, on delivery only.
      try {
        await tools["ledger.recordOutputExcerpt"]?.execute({ agentId: "tiktok-agent", runId: wf.runId, excerpt: `${copy.caption}\n\n${copy.about}` }, { ctx });
      } catch (error) {
        console.error("13-commit-and-record: could not record the output excerpt for future dedup", error);
      }
      const memory = tools["memory.appendDecision"];
      if (memory) {
        await memory.execute(
          {
            decisionId: `${wf.runId}__decision`,
            summary: format === "original-short" ? `Made an original short on "${topic}"${voiceover ? " with voiceover" : ""}` : `Clipped "${topic}" (${moment.hookType})`,
          },
          { ctx },
        );
      }
    });

    return {
      topic,
      topicSource: intake.topicSource,
      lane: CLIP_LANE,
      format,
      moment,
      commentary: copy,
      ...(script ? { script } : {}),
      voiceover,
      deliverableId,
      durationSeconds,
    };
  };
}
