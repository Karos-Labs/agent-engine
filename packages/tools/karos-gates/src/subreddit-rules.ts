import { z } from "zod";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.1.0";

export const SubredditRulesGateInputSchema = z.object({
  // text/subreddit/offLimits/aiContentBanned/disclosureRequired/requiredDisclosure/minKarma/minAccountAgeDays have no existing TSDoc to transcribe (SCRUM-293 flag) — descriptions synthesized from the tool's own doc comment and execute()'s usage of each field.
  text: z.string().describe("The draft text being checked before it posts to `subreddit`."),
  subreddit: z.string().min(1).describe("The target subreddit's name (without the r/ prefix), e.g. \"personalfinance\"."),
  /** Mirrors `SubredditRulesLookup.configStatus` (`client.getSubredditRules`) — carried through so a fully unconfigured client passes cleanly rather than being punished for data it never supplied. */
  configStatus: z
    .enum(["configured", "unconfigured"])
    .default("unconfigured")
    .describe(
      "Mirrors `SubredditRulesLookup.configStatus` (`client.getSubredditRules`) — carried through so a fully unconfigured client passes cleanly rather than being punished for data it never supplied.",
    ),
  offLimits: z.boolean().default(false).describe("Whether this client has been banned from, or otherwise ruled off-limits for, `subreddit`."),
  aiContentBanned: z.boolean().default(false).describe("Whether `subreddit`'s own rules ban AI-assisted content outright."),
  disclosureRequired: z.boolean().default(false).describe("Whether `subreddit` requires a disclosure statement when the draft mentions the product."),
  requiredDisclosure: z.string().optional().describe("The exact disclosure text `subreddit` requires, checked against `text` when `disclosureRequired` is true."),
  minKarma: z.number().optional().describe("`subreddit`'s minimum account karma to post, if it has one. Unset means \"cannot check,\" not \"no minimum.\""),
  minAccountAgeDays: z
    .number()
    .optional()
    .describe("`subreddit`'s minimum account age in days to post, if it has one. Unset means \"cannot check,\" not \"no minimum.\""),
  /** The connecting account's real karma/age, if known — Phase 1 has no live Reddit account data source, so these are normally absent, not synthesized. */
  accountKarma: z
    .number()
    .optional()
    .describe("The connecting account's real karma, if known — Phase 1 has no live Reddit account data source, so this is normally absent, not synthesized."),
  accountAgeDays: z
    .number()
    .optional()
    .describe("The connecting account's real age in days, if known — Phase 1 has no live Reddit account data source, so this is normally absent, not synthesized."),
  /**
   * Whether this draft actually contains a product mention. Phase 1 has no
   * `account.json`-style `mention_names` text scan (`check-draft.mjs`
   * BANNED_PHRASES/mention logic in the legacy engine); the caller derives
   * this from the draft's own self-reported `disclosureIncluded` flag
   * instead (a mention with no disclosure is already rejected by the check
   * below, so "disclosed" and "mentioned" are the same event in practice
   * today). Defaults false so a pre-draft call — before any draft text
   * exists — never spuriously trips the warming/cooldown checks.
   */
  mentionAttempted: z
    .boolean()
    .default(false)
    .describe(
      "Whether this draft actually contains a product mention. Phase 1 has no `account.json`-style `mention_names` text scan; the caller derives this from the draft's own self-reported `disclosureIncluded` flag instead. Defaults false so a pre-draft call never spuriously trips the warming/cooldown checks.",
    ),
  /**
   * The client's own product and brand names, for an actual text scan.
   *
   * `mentionAttempted` above is the DRAFT'S OWN WORD for whether it mentions
   * the product, and a model that names the product while answering
   * `disclosureIncluded: false` turns every check that depends on it into a
   * no-op: the warming window, the cooldown, and the disclosure requirement all
   * pass, and an undisclosed product mention ships to a human to post under
   * their own account. On Reddit that is the single fastest way to get one
   * banned, and it is not recoverable by editing the comment afterwards.
   *
   * Given names, this gate reads the text instead of taking the model's word
   * for it. Empty (the default) keeps the old self-report-only behaviour, so a
   * caller with no names configured is no worse off than before.
   */
  mentionNames: z
    .array(z.string())
    .default([])
    .describe(
      "The client's product and brand names, scanned for in `text` on whole-word boundaries. Supplied so the mention checks do not rest on the draft's own self-reported `disclosureIncluded`; empty means the self-report is all there is.",
    ),
  /** Mirrors `SubredditRulesLookup.mentionCooldownDays`/`lastMentionAt`/`accountWarmingUntil` — see that file for what each means. */
  mentionCooldownDays: z
    .number()
    .optional()
    .describe("Mirrors `SubredditRulesLookup.mentionCooldownDays` — the number of days that must elapse between product mentions in this subreddit."),
  lastMentionAt: z
    .string()
    .optional()
    .describe("Mirrors `SubredditRulesLookup.lastMentionAt` — an ISO date string for when this account last mentioned the product in this subreddit."),
  accountWarmingUntil: z
    .string()
    .optional()
    .describe("Mirrors `SubredditRulesLookup.accountWarmingUntil` — an ISO date string before which this account may not mention the product at all."),
  /**
   * The caller's clock reading, as an ISO date string. This gate is a pure
   * function and must never read the system clock itself (so a fixture can
   * pin "now" and get a deterministic verdict); the caller supplies it the
   * same way `step.gate` responses already carry `at: new Date().toISOString()`.
   * Absent `now` means the warming/cooldown checks cannot run — "cannot
   * check," not "assume it fails," same posture as an absent `accountKarma`.
   */
  now: z
    .string()
    .optional()
    .describe(
      "The caller's clock reading, as an ISO date string. This gate is a pure function and must never read the system clock itself. Absent `now` means the warming/cooldown checks cannot run.",
    ),
});
export type SubredditRulesGateInput = z.infer<typeof SubredditRulesGateInputSchema>;

/**
 * `gate.subredditRules`'s own result type — a strict superset of the shared
 * `GateVerdict` (every variant is still a valid `GateVerdict`), following the
 * same `configStatus`-carrying pattern `gate.brandCompliance` established:
 * a client with no subreddit rules configured for this subreddit passes
 * (never punished for enrichment it never supplied), but that pass is
 * flagged as `configStatus: "unconfigured"` rather than indistinguishable
 * from a real, checked "clear to post."
 */
export type SubredditRulesVerdict =
  | { verdict: "pass"; evidence: string[]; toolVersion: string; configStatus: "configured" | "unconfigured" }
  | { verdict: "content_fail"; evidence: string[]; reason: string; toolVersion: string; configStatus: "configured" }
  | { verdict: "tooling_error"; reason: string; toolVersion: string };

/**
 * Checks whether a draft can actually post to its target subreddit (RFC-02
 * §5 migration audit, Reddit P0): a subreddit the client has been banned
 * from (`offLimits`), one whose own rules ban AI-assisted content
 * (`aiContentBanned`), an attempted mention while the account is still
 * warming (`accountWarmingUntil`) or inside its per-subreddit mention
 * cooldown (`lastMentionAt` + `mentionCooldownDays`), a mention-disclosure
 * requirement the draft doesn't satisfy, or an account below the
 * subreddit's configured karma/age floor — whichever of these the caller
 * actually has data for. Never fabricates an account's karma/age/warming
 * state when it isn't supplied; an unset threshold or an unset account
 * value both mean "cannot check," not "assume it fails." Phase 1 has no
 * live Reddit account-state store (real karma, real warming history, a real
 * mention ledger), so every one of these fields is normally absent in
 * production today — but the check logic itself is real: given fixture
 * data (as this package's tests supply), it enforces the exact legacy rule
 * (`reddit-agent-v2/references/reddit-craft.md` §7, "no mention while
 * warming... no mention without disclosure").
 */
/**
 * Which of `names` the text actually names, on whole-word boundaries.
 *
 * Whole-word, because substring matching on a brand name is how "Karos" fires
 * on "karoshi" and a clean draft gets held for a mention that is not there —
 * and a gate that cries wolf is a gate somebody switches off.
 *
 * Names shorter than three characters are skipped: they are almost always an
 * initialism that collides with an ordinary word, and the false-positive cost
 * outweighs what they catch.
 *
 * Exported so its behaviour is testable on its own, since the interesting cases
 * (possessives, hyphens, casing, a name inside a URL) are all about this
 * function and not about the gate's control flow.
 */
export function detectProductMentions(text: string, names: readonly string[]): string[] {
  const found: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length < 3) continue;
    // Escaped whole, so a name containing "." or "+" ("Notion.so", "C++ Shop")
    // matches literally rather than as a pattern.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Not `\b` on both ends: a name ending in a non-word character (".so")
    // would never satisfy a trailing `\b`. Anchored on "not a word character"
    // instead, which is the property actually wanted.
    const pattern = new RegExp(`(^|[^\\w])${escaped}($|[^\\w])`, "i");
    if (pattern.test(text)) found.push(name);
  }
  return found;
}

export const subredditRules = defineTool<SubredditRulesGateInput, SubredditRulesVerdict>({
  name: "gate.subredditRules",
  description:
    "Checks whether a draft can actually post to its target subreddit: off-limits status, an AI-content ban, mention warming/cooldown windows, a missing required disclosure, or an account below the subreddit's karma/age floor — whichever of these the caller actually has data for. Never fabricates account state it wasn't given; an unset threshold or value means \"cannot check,\" not \"assume it fails.\"",
  version: TOOL_VERSION,
  inputSchema: SubredditRulesGateInputSchema,
  async execute({
    subreddit,
    configStatus,
    offLimits,
    aiContentBanned,
    disclosureRequired,
    requiredDisclosure,
    minKarma,
    minAccountAgeDays,
    accountKarma,
    accountAgeDays,
    mentionAttempted,
    mentionNames,
    mentionCooldownDays,
    lastMentionAt,
    accountWarmingUntil,
    now,
    text,
  }) {
    // THE DRAFT'S SELF-REPORT IS NOT EVIDENCE. `mentionAttempted` is what the
    // model said about its own text; the scan is what the text says. Either one
    // is enough to count as a mention — a model that under-reports must not
    // switch the warming, cooldown and disclosure checks off, and one that
    // over-reports is being cautious, which costs nothing here.
    const scanned = detectProductMentions(text, mentionNames);
    const mentions = mentionAttempted || scanned.length > 0;

    if (offLimits) {
      return success<SubredditRulesVerdict>({
        verdict: "content_fail",
        evidence: [subreddit],
        reason: `r/${subreddit} is off-limits for this client`,
        toolVersion: TOOL_VERSION,
        configStatus: "configured",
      });
    }

    if (aiContentBanned) {
      return success<SubredditRulesVerdict>({
        verdict: "content_fail",
        evidence: [subreddit],
        reason: `r/${subreddit}'s own rules ban AI-assisted content — do not post there`,
        toolVersion: TOOL_VERSION,
        configStatus: "configured",
      });
    }

    if (mentions && accountWarmingUntil && now) {
      const nowMs = Date.parse(now);
      const warmingUntilMs = Date.parse(accountWarmingUntil);
      if (!Number.isNaN(nowMs) && !Number.isNaN(warmingUntilMs) && nowMs < warmingUntilMs) {
        return success<SubredditRulesVerdict>({
          verdict: "content_fail",
          evidence: [`now=${now}`, `accountWarmingUntil=${accountWarmingUntil}`],
          reason: `this account is still in its legacy warming period until ${accountWarmingUntil} — no product mention may ship yet (reddit-craft.md §7)`,
          toolVersion: TOOL_VERSION,
          configStatus: "configured",
        });
      }
    }

    if (mentions && lastMentionAt && mentionCooldownDays !== undefined && now) {
      const nowMs = Date.parse(now);
      const lastMentionMs = Date.parse(lastMentionAt);
      if (!Number.isNaN(nowMs) && !Number.isNaN(lastMentionMs)) {
        const elapsedDays = (nowMs - lastMentionMs) / (24 * 60 * 60 * 1000);
        if (elapsedDays < mentionCooldownDays) {
          return success<SubredditRulesVerdict>({
            verdict: "content_fail",
            evidence: [`lastMentionAt=${lastMentionAt}`, `mentionCooldownDays=${mentionCooldownDays}`, `elapsedDays=${elapsedDays.toFixed(2)}`],
            reason: `r/${subreddit}'s mention cooldown hasn't elapsed: this account last mentioned the product on ${lastMentionAt}, and ${mentionCooldownDays} day(s) must pass first (only ${elapsedDays.toFixed(1)} have)`,
            toolVersion: TOOL_VERSION,
            configStatus: "configured",
          });
        }
      }
    }

    // The draft names the product and told us it did not. Whatever the
    // subreddit's disclosure rule says, this is the fact that every other
    // mention check was resting on, and it was wrong — so say so rather than
    // let the run continue on a corrected flag the reviewer never sees.
    if (scanned.length > 0 && !mentionAttempted) {
      return success<SubredditRulesVerdict>({
        verdict: "content_fail",
        evidence: scanned,
        reason:
          `the draft names the product (${scanned.join(", ")}) but reported no mention — on Reddit an undisclosed ` +
          `product mention is what gets an account banned, and editing the comment afterwards does not undo it. ` +
          `Either drop the name or set the disclosure.`,
        toolVersion: TOOL_VERSION,
        configStatus: "configured",
      });
    }

    if (disclosureRequired && requiredDisclosure && !text.toLowerCase().includes(requiredDisclosure.toLowerCase())) {
      return success<SubredditRulesVerdict>({
        verdict: "content_fail",
        evidence: [requiredDisclosure],
        reason: `r/${subreddit} requires a disclosure the draft is missing`,
        toolVersion: TOOL_VERSION,
        configStatus: "configured",
      });
    }

    if (minKarma !== undefined && accountKarma !== undefined && accountKarma < minKarma) {
      return success<SubredditRulesVerdict>({
        verdict: "content_fail",
        evidence: [`accountKarma=${accountKarma}`, `minKarma=${minKarma}`],
        reason: `account karma (${accountKarma}) is below r/${subreddit}'s minimum (${minKarma})`,
        toolVersion: TOOL_VERSION,
        configStatus: "configured",
      });
    }

    if (minAccountAgeDays !== undefined && accountAgeDays !== undefined && accountAgeDays < minAccountAgeDays) {
      return success<SubredditRulesVerdict>({
        verdict: "content_fail",
        evidence: [`accountAgeDays=${accountAgeDays}`, `minAccountAgeDays=${minAccountAgeDays}`],
        reason: `account age (${accountAgeDays} days) is below r/${subreddit}'s minimum (${minAccountAgeDays} days)`,
        toolVersion: TOOL_VERSION,
        configStatus: "configured",
      });
    }

    if (configStatus === "unconfigured") {
      return success<SubredditRulesVerdict>({
        verdict: "pass",
        evidence: [`WARNING: no subreddit rules configured for r/${subreddit} — promo/disclosure/karma/age posture was not actually checked`],
        toolVersion: TOOL_VERSION,
        configStatus: "unconfigured",
      });
    }

    return success<SubredditRulesVerdict>({
      verdict: "pass",
      evidence: [`r/${subreddit} rules checked — clear to post`],
      toolVersion: TOOL_VERSION,
      configStatus: "configured",
    });
  },
});
