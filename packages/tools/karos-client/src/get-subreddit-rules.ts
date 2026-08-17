import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";
const SEGMENTS = ["client", "subreddit-rules"] as const;

export const GetSubredditRulesInputSchema = z.object({ subreddit: z.string().min(1) });
export type GetSubredditRulesInput = z.infer<typeof GetSubredditRulesInputSchema>;

/** One subreddit's configured posting rules — an optional enrichment a client may set up per target subreddit. */
export interface SubredditRulesEntry {
  /** Permanently blocks this client from ever posting here again (e.g. after a prior ban). */
  offLimits?: boolean;
  /** This subreddit's own rules forbid AI-assisted/AI-generated posts. */
  aiContentBanned?: boolean;
  /** Any mention of the client's product/company must carry a disclosure line. */
  disclosureRequired?: boolean;
  /** The exact disclosure phrase `gate.subredditRules` checks for, if `disclosureRequired` is set. */
  requiredDisclosure?: string;
  minKarma?: number;
  minAccountAgeDays?: number;
  /**
   * How many days must elapse between two product mentions from this
   * account in this subreddit (legacy `mention_cooldown_days`,
   * reddit-agent-v2 `references/run-protocol.md` step 07's rules row).
   * Undefined means "no cooldown configured," not "no cooldown required" —
   * `gate.subredditRules` only enforces it when both this and `lastMentionAt`
   * are present.
   */
  mentionCooldownDays?: number;
  /** ISO date this account last mentioned the product in this subreddit (legacy `mention_history`). Undefined means "never mentioned, or not tracked yet." */
  lastMentionAt?: string;
  /**
   * ISO date this account's legacy warming period ends. While `now` is
   * before this date, the account "has not yet earned the standing to name
   * its own product" (reddit-craft.md §7) and no mention may ship,
   * regardless of the subreddit's own promo verdict. Undefined means either
   * "not warming" or "warming state not tracked yet" — both read as
   * unconstrained, same as every other Phase-1-stubbed account field here.
   */
  accountWarmingUntil?: string;
  [key: string]: unknown;
}

/**
 * The resolved, per-lookup shape `gate.subredditRules` consumes directly —
 * `configStatus` distinguishes "this client has never configured rules for
 * any subreddit" and "this specific subreddit has no entry yet" from "rules
 * are configured and here they are," the same distinction
 * `gate.brandCompliance` draws (RFC-01 §5.6) — never silently indistinguishable
 * from a real, checked "nothing wrong here."
 */
export interface SubredditRulesLookup {
  subreddit: string;
  configStatus: "configured" | "unconfigured";
  offLimits: boolean;
  aiContentBanned: boolean;
  disclosureRequired: boolean;
  requiredDisclosure?: string;
  minKarma?: number;
  minAccountAgeDays?: number;
  mentionCooldownDays?: number;
  lastMentionAt?: string;
  accountWarmingUntil?: string;
}

/**
 * Read-only lookup of one subreddit's configured posting rules (promo/
 * disclosure/AI-content/karma-and-age-floor posture) for the current tenant.
 * Tenant is resolved exclusively from `context.ctx.clientSlug`. A client that
 * has never configured subreddit rules at all — or simply hasn't configured
 * this particular subreddit yet — gets `configStatus: "unconfigured"` and
 * fully permissive defaults, never a `not_available`/blocked outcome: rules
 * are optional enrichment a client opts into, not a required onboarding step
 * (unlike `client.getProfile`).
 */
export function createGetSubredditRules(store: WorkspaceStoreLike) {
  return defineTool<GetSubredditRulesInput, SubredditRulesLookup>({
    name: "client.getSubredditRules",
    version: TOOL_VERSION,
    inputSchema: GetSubredditRulesInputSchema,
    async execute({ subreddit }, { ctx }) {
      const allRules = await store.readJson<Record<string, SubredditRulesEntry>>(ctx.clientSlug, [...SEGMENTS]);
      const entry = allRules?.[subreddit.toLowerCase()];

      if (!entry) {
        return success<SubredditRulesLookup>({
          subreddit,
          configStatus: "unconfigured",
          offLimits: false,
          aiContentBanned: false,
          disclosureRequired: false,
        });
      }

      return success<SubredditRulesLookup>({
        subreddit,
        configStatus: "configured",
        offLimits: entry.offLimits ?? false,
        aiContentBanned: entry.aiContentBanned ?? false,
        disclosureRequired: entry.disclosureRequired ?? false,
        ...(entry.requiredDisclosure !== undefined ? { requiredDisclosure: entry.requiredDisclosure } : {}),
        ...(entry.minKarma !== undefined ? { minKarma: entry.minKarma } : {}),
        ...(entry.minAccountAgeDays !== undefined ? { minAccountAgeDays: entry.minAccountAgeDays } : {}),
        ...(entry.mentionCooldownDays !== undefined ? { mentionCooldownDays: entry.mentionCooldownDays } : {}),
        ...(entry.lastMentionAt !== undefined ? { lastMentionAt: entry.lastMentionAt } : {}),
        ...(entry.accountWarmingUntil !== undefined ? { accountWarmingUntil: entry.accountWarmingUntil } : {}),
      });
    },
  });
}
