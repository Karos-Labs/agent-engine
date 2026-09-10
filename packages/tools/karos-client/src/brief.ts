import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/**
 * The Client Brief — the one compact document that says who a client is,
 * what they sell, to whom, and in which words, so every step that reasons
 * about a post (topic scout, research query, copy, relevance judge) reasons
 * about THIS business and not about "a business".
 *
 * ## Why this exists
 *
 * Instagram prep run audit (2026-09-08): `04a-research-pull` sent the run's
 * request verbatim as the web query ("Create content that introduces the new
 * offer to first-time buyers") with nothing about the client attached, and
 * Karos Labs, an AI marketing agency, shipped a real-estate carousel about
 * MassHousing and Gen H. Every downstream check passed, because no check
 * ever asked "is this post about the client?". The brief is the artifact
 * that question is asked against.
 *
 * ## Two writers, one schema
 *
 * Phase 0 derives a brief deterministically from the onboarding data already
 * in the workspace (`generatedBy: "deterministic"`, `confidence: "low"`) and
 * never persists it. Phase 1 adds a setup-style agent that reads the same
 * data plus the client's site and recent posts, and persists the result at
 * `clients/<slug>/brief/<channel>-brief.json` through `client.writeBrief`
 * (`generatedBy: "agent"`). A human may also author or edit one in the
 * portal (`generatedBy: "human"`). All three produce exactly this shape, so
 * every consumer reads one type and the persisted brief is a drop-in for the
 * derived one — `isBriefStale` (in the instagram agent) is the only place
 * the difference between them matters.
 *
 * ## Field notes
 *
 * - `coreTerms` is `min(1)`: a brief with no vocabulary cannot ground a
 *   search query, and the deterministic writer always has at least the
 *   industry to fall back on.
 * - `referenceAccounts.platform` is restricted to the four platforms
 *   `research.socialHistory` can actually read (x, instagram, reddit,
 *   tiktok). A LinkedIn or YouTube reference would be a row nothing can act
 *   on, so the schema refuses it rather than letting it look useful.
 * - `sources` names where each brief's content came from and `gaps` names
 *   what was missing; together they are how a reviewer tells a well-grounded
 *   brief from one built on an empty profile.
 */
export const BRIEF_TTL_DAYS = 30;

/** Store path segments for a channel's brief: `clients/<slug>/brief/<channel>-brief.json`. */
export function briefSegments(channel: string): string[] {
  return ["brief", `${channel}-brief`];
}

export const BriefChannelSchema = z.enum(["instagram", "x", "linkedin", "tiktok", "reddit"]);
export type BriefChannel = z.infer<typeof BriefChannelSchema>;

export const BriefSourceSchema = z.object({
  kind: z.enum(["profile", "brand", "voice-rules", "context-doc", "knowledge", "intel", "site", "social-history"]),
  /** What exactly was read: a tool name, a docType, a URL, a handle. */
  ref: z.string(),
});
export type BriefSource = z.infer<typeof BriefSourceSchema>;

export const ClientBriefSchema = z.object({
  version: z.literal(1),
  channel: BriefChannelSchema,
  generatedAt: z.iso.datetime(),
  generatedBy: z.enum(["deterministic", "agent", "human"]),
  /** The `skillRef` of the agent that wrote it, when `generatedBy: "agent"`. */
  agentSkillRef: z.string().optional(),
  sources: z.array(BriefSourceSchema).default([]),
  positioning: z.object({
    oneLiner: z.string().min(1).max(240),
    whatWeSell: z.string().min(1).max(400),
    differentiators: z.array(z.string()).max(6).default([]),
  }),
  icp: z.object({
    summary: z.string().min(1).max(240),
    roles: z.array(z.string()).max(6).default([]),
    pains: z.array(z.string()).max(6).default([]),
    industries: z.array(z.string()).max(6).default([]),
    geos: z.array(z.string()).max(4).default([]),
  }),
  offers: z
    .array(
      z.object({
        name: z.string().min(1),
        summary: z.string().min(1),
        url: z.string().optional(),
        validUntil: z.string().optional(),
      }),
    )
    .max(5)
    .default([]),
  coreTerms: z.array(z.string().min(1)).min(1).max(20),
  // Only the platforms `research.socialHistory` can read — see the header.
  referenceAccounts: z
    .array(
      z.object({
        platform: z.enum(["x", "instagram", "reddit", "tiktok"]),
        handle: z.string().min(1),
        why: z.string().min(1),
      }),
    )
    .max(7)
    .default([]),
  forbidden: z.object({
    topics: z.array(z.string()).default([]),
    claims: z.array(z.string()).default([]),
  }),
  language: z.object({
    target: z.string().optional(),
    register: z.string().optional(),
  }),
  evergreenAngles: z.array(z.string()).max(8).default([]),
  ownAssets: z
    .array(
      z.object({
        title: z.string(),
        kind: z.enum(["case_study", "data", "event", "product", "doc"]),
        summary: z.string(),
        sourceRef: z.string(),
      }),
    )
    .max(12)
    .default([]),
  confidence: z.enum(["high", "medium", "low"]),
  gaps: z.array(z.string()).default([]),
});
export type ClientBrief = z.infer<typeof ClientBriefSchema>;

/**
 * Whole days since `brief.generatedAt`, floored and never negative (a clock
 * skew between the writer and the reader must not make a brief look fresher
 * than "written today"). `NaN` for an unparseable timestamp, so a caller
 * comparing against a TTL sees `false` for "fresh" — the safe direction.
 */
export function briefAgeDays(brief: Pick<ClientBrief, "generatedAt">, now: Date = new Date()): number {
  const generated = Date.parse(brief.generatedAt);
  if (Number.isNaN(generated)) return Number.NaN;
  return Math.max(0, Math.floor((now.getTime() - generated) / 86_400_000));
}

export const GetBriefInputSchema = z.object({
  channel: BriefChannelSchema.describe("Which channel's brief to read (instagram, x, linkedin, tiktok, reddit). Tenant comes from context."),
});
export type GetBriefInput = z.infer<typeof GetBriefInputSchema>;

export interface GetBriefResult {
  brief: ClientBrief;
  /** Whole days since the brief was generated, so a caller can apply `BRIEF_TTL_DAYS` without re-parsing dates. */
  ageDays: number;
}

/**
 * `client.getBrief` — the persisted Client Brief for one channel.
 *
 * `not_available` (never a throw) for a missing brief, which is the normal
 * state for every client until Phase 1's writer has run for them: the
 * instagram workflow derives a deterministic brief in its place. A brief
 * that exists but no longer parses against `ClientBriefSchema` v1 is ALSO
 * `not_available`, with a reason that says so — a consumer must never build
 * a run on a half-valid document, and the derived fallback is always
 * available, so refusing here costs nothing but a weaker brief for one run.
 * The two reasons differ on purpose, the same way `client.getContextDoc`
 * separates "missing" from "present but empty".
 */
export function createGetBrief(store: WorkspaceStoreLike) {
  return defineTool<GetBriefInput, GetBriefResult>({
    name: "client.getBrief",
    description:
      "Read-only lookup of the client's persisted Client Brief for one channel (positioning, ICP, offers, core terms, reference accounts, forbidden topics/claims, language), with its age in days. Reports not_available (not an error) when no brief has been written for that channel yet.",
    version: TOOL_VERSION,
    inputSchema: GetBriefInputSchema,
    async execute({ channel }, { ctx }) {
      const raw = await store.readJson<unknown>(ctx.clientSlug, briefSegments(channel));
      if (raw === undefined || raw === null) {
        return notAvailable<GetBriefResult>(`no ${channel} brief for this client`);
      }
      const parsed = ClientBriefSchema.safeParse(raw);
      if (!parsed.success) {
        return notAvailable<GetBriefResult>(
          `the ${channel} brief for client "${ctx.clientSlug}" does not match ClientBriefSchema v1 and was not used — ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      return success<GetBriefResult>({ brief: parsed.data, ageDays: briefAgeDays(parsed.data) });
    },
  });
}
