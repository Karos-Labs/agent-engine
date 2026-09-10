import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { contentFail, defineTool, notAvailable, success } from "@agent-engine/tool-common";

/**
 * `client.getBrief`'s own version. 1.1.0 since Phase 1 (item H): the reader
 * is unchanged in shape, but the document it serves is no longer only the
 * deterministic stand-in — `client.writeBrief` below now persists
 * agent-written briefs into the same path, so a `generatedBy: "agent"` answer
 * from this tool starts here. Telemetry has to be able to tell a call made
 * before that from one made after (the rule `scripts/check-tool-versions.ts`
 * enforces: a changed tool file declares a changed version).
 */
const GET_BRIEF_VERSION = "1.1.0";
/** `client.writeBrief`'s own version — new in Phase 1, so it starts at 1.0.0 rather than inheriting the reader's. */
const WRITE_BRIEF_VERSION = "1.0.0";

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
 * - `referenceAccounts.domain` is the one field on that row a web search can
 *   filter by, and it is deliberately separate from `handle`: a handle is a
 *   social identifier ("lennysan", "SaaS"), never a hostname, and a research
 *   lane that treated one as the other would restrict its search to a domain
 *   that does not exist.
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
        /**
         * The publication's own hostname, when this account belongs to one
         * ("lennysnewsletter.com" for `@lennysan`). Optional, and a HOST
         * rather than a URL: it is the only field here a domain-restricted
         * web search can use, and a social handle is not one — the research
         * lane that asks "what did the publications this brief names write
         * about the subject" reads this and nothing else.
         */
        domain: z.string().min(1).optional(),
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
    version: GET_BRIEF_VERSION,
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

/**
 * `client.writeBrief`'s payload: a whole brief minus `generatedAt`, which the
 * tool stamps itself.
 *
 * Stamped rather than accepted because `generatedAt` is what every staleness
 * decision downstream is made on (`briefAgeDays`, `BRIEF_TTL_DAYS`,
 * `isBriefStale`, `resolveBriefFreshness`). A caller — worse, a model filling
 * an output schema — that can set it can also date a brief in the future and
 * make it permanently fresh, or backdate one and make the writer re-run every
 * run. The one field this document is trusted on is the one field its writer
 * does not get to choose.
 */
export const WriteBriefInputSchema = z.object({
  channel: BriefChannelSchema.describe("Which channel's brief to write (instagram, x, linkedin, tiktok, reddit). Must match `brief.channel`. Tenant comes from context."),
  brief: ClientBriefSchema.omit({ generatedAt: true }).describe("The brief itself, minus `generatedAt` — the tool stamps that with the write time."),
});
export type WriteBriefInput = z.input<typeof WriteBriefInputSchema>;

export interface WriteBriefResult {
  /** False when a brief already existed at this path and was replaced — the same "created" semantics every workspace write reports. */
  created: boolean;
  /** The replaced brief's `generatedAt`, when there was one. How a caller sees that it refreshed rather than seeded. */
  previousGeneratedAt?: string;
  /** What was replaced, so a run record shows an agent brief overwriting an agent brief rather than only "created: false". */
  previousGeneratedBy?: ClientBrief["generatedBy"];
  /** Where it landed, for the run record. */
  path: string;
}

/**
 * `client.writeBrief` — the ONE writer in an otherwise read-only registry.
 *
 * ## Why the exception is safe
 *
 * Three properties, each of which is the reason a "read-only server" can
 * carry this without the label becoming a lie:
 *
 * 1. **Schema-validated.** The payload is parsed against `ClientBriefSchema`
 *    before anything touches the store, so the document `client.getBrief`
 *    reads back always parses. An agent-authored brief is model output; the
 *    validation is what keeps a malformed one from becoming the grounding
 *    every later step trusts.
 * 2. **Channel-scoped and tenant-scoped.** It can write exactly one path per
 *    channel (`briefSegments`), under the tenant `ctx.clientSlug` names. No
 *    argument reaches the path, so there is no shape of input that writes
 *    somewhere else — the same structural rule the read side has.
 * 3. **It never overwrites a human.** A brief with `generatedBy: "human"` is
 *    somebody's deliberate correction of what the agent inferred, and the
 *    refresh cycle runs unattended every 30 days. Refusing here (a
 *    `content_fail` naming the date it was authored) is what makes a portal
 *    edit permanent rather than something a scheduled run silently reverts.
 *    A human brief is replaced only by another human write — through the
 *    portal, not through this tool.
 *
 * `content_fail`, not `tooling_error`, for both refusals: nothing is broken.
 * The caller asked for something this tool declines to do, and its caller
 * (`00b3-persist-client-brief`) records the refusal and carries on with the
 * brief already on disk rather than failing a run over it.
 */
export function createWriteBrief(store: WorkspaceStoreLike) {
  return defineTool<WriteBriefInput, WriteBriefResult>({
    name: "client.writeBrief",
    description:
      "Persist the client's Client Brief for one channel (positioning, ICP, offers, core terms, reference accounts, forbidden topics/claims, language). The payload is validated against ClientBriefSchema and stamped with generatedAt. Reports content_fail — never a partial write — when the payload is invalid, when its channel disagrees with the requested one, or when the stored brief was authored by a human (a portal edit is never reverted by an unattended refresh).",
    version: WRITE_BRIEF_VERSION,
    inputSchema: WriteBriefInputSchema,
    async execute(rawInput, { ctx }) {
      // `defineTool` has already parsed the input against the schema above
      // (defaults applied) — same note as `research.pull`'s own cast.
      const { channel, brief } = rawInput as z.output<typeof WriteBriefInputSchema>;
      if (brief.channel !== channel) {
        return contentFail<WriteBriefResult>(
          `client.writeBrief: the requested channel "${channel}" and the brief's own channel "${brief.channel}" disagree — one brief per channel, and the document has to say which it is`,
        );
      }

      const segments = briefSegments(channel);
      const existingRaw = await store.readJson<unknown>(ctx.clientSlug, segments);
      // Read with a LENIENT parse: a stored brief that no longer matches the
      // schema must still be able to say "a human wrote me". Refusing to
      // overwrite is about authorship, and authorship survives a shape change
      // that `client.getBrief` would (rightly) decline to serve.
      const existing = existingRaw === undefined || existingRaw === null ? undefined : (existingRaw as Partial<ClientBrief>);
      if (existing?.generatedBy === "human") {
        return contentFail<WriteBriefResult>(
          `client.writeBrief: the stored ${channel} brief for client "${ctx.clientSlug}" was authored by a human${
            typeof existing.generatedAt === "string" ? ` on ${existing.generatedAt.slice(0, 10)}` : ""
          } and is never overwritten by an automated refresh — edit it in the portal, or delete it there first`,
        );
      }

      const stamped: ClientBrief = { ...brief, generatedAt: new Date().toISOString() };
      // Belt: the omit-then-restore round trip is what the input schema
      // already guarantees, but this document's whole value is that every
      // reader can trust it parses, so it is parsed once more as the thing
      // that will actually be stored.
      const validated = ClientBriefSchema.safeParse(stamped);
      if (!validated.success) {
        return contentFail<WriteBriefResult>(
          `client.writeBrief: the stamped brief does not match ClientBriefSchema v1 — ${validated.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }

      const write = await store.writeJson(ctx.clientSlug, segments, validated.data);
      return success<WriteBriefResult>({
        created: write.created,
        ...(typeof existing?.generatedAt === "string" ? { previousGeneratedAt: existing.generatedAt } : {}),
        ...(existing?.generatedBy !== undefined ? { previousGeneratedBy: existing.generatedBy } : {}),
        path: write.filePath,
      });
    },
  });
}
