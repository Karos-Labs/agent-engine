import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import {
  LinkedInSetupInputSchema,
  RedditSetupInputSchema,
  normalizeSubreddit,
  slugifySeat,
  type LinkedInSeatIntake,
  type RedditSetupInput,
} from "./types.js";

/**
 * Channel setup, as a pre-flight the drafting agents run themselves.
 *
 * ## Why this stopped being its own agent
 *
 * `linkedin-setup-agent` and `reddit-setup-agent` were separate products in the
 * catalog, which put the burden of sequencing on the person: notice the channel
 * has no charter, find the setup card, run it, then come back and run the real
 * agent. Nothing enforced that order and nothing announced it — a LinkedIn run
 * against an unconfigured client simply drafted without a charter, and a Reddit
 * run blocked on intake with a message about subreddits rather than about the
 * form nobody had filled in.
 *
 * The work itself was never the problem, so it is unchanged below: the same
 * validation, the same rendered documents, the same paths. What changed is who
 * decides when it runs. Each drafting agent now checks its own channel context
 * first and records the form in-flight if one arrived with the run.
 *
 * ## Still code, still not a model
 *
 * No `step.agent` anywhere, for the reason the standalone agents gave: a setup
 * run records what a person said, and a model in that path can only paraphrase
 * it — which for a document whose whole purpose is "never post about X" is a
 * way to lose the X.
 *
 * ## Drafting agents can now write one document each
 *
 * `intake.saveStrategy`'s own comment says setup agents get it and drafting
 * agents do not, and that separation was right when a drafting agent had no
 * business writing a charter. It still holds in substance: these two functions
 * are the only callers, they write only their own channel's document, and they
 * only write at all when the channel has none and the run carried a filled
 * form. What a drafting agent cannot do is rewrite a charter that already
 * exists — the probe returns `already-configured` before any write is reached.
 */

/** What a pre-flight decided, recorded on the step so a run says which path it took. */
export interface ChannelSetupOutcome {
  /**
   * - `already-configured` — the channel had its context; nothing was written.
   * - `recorded` — the run carried a filled form and it was stored.
   * - `not-supplied` — no context and no form; the caller decides if that is fatal.
   */
  status: "already-configured" | "recorded" | "not-supplied";
  /** Strategy documents written by THIS run, by store path. Empty unless `recorded`. */
  written: string[];
  /** Parts of a submitted form that could not be stored, and why — never silently dropped. */
  skipped: { key: string; reason: string }[];
  /** One line for the trace, so a skip is legible without opening the store. */
  note: string;
}

/** The machine-readable half of a Reddit charter, as `client.getStrategy` hands it back. */
export interface RedditCharterData {
  /** Normalised `r/<name>` form. */
  targetSubreddits: string[];
  accountName?: string;
  offLimitsTopics?: string[];
  /** Words a thread worth replying to would contain. Written by the auto-derived path; a form may add them later. */
  searchKeywords?: string[];
  voiceNotes?: string;
  disclosureLine?: string;
  /**
   * True when the engine derived this charter itself because the client had
   * nothing on file. Such a charter is replaceable: a later run carrying a
   * real setup form overwrites it, where a form-recorded charter is never
   * overwritten by a drafting run.
   */
  autoDerived?: boolean;
}

/** Reddit's pre-flight also resolves the allowlist, which its intake check needs as data rather than prose. */
export interface RedditChannelSetupOutcome extends ChannelSetupOutcome {
  /** Communities this client may post into, normalised. Empty when `not-supplied`. */
  targetSubreddits: string[];
  /** The rest of the stored charter, when one exists (or was just written). */
  charter?: RedditCharterData;
}

export interface ChannelSetupArgs {
  tools: AgentToolRegistry;
  ctx: AgentContext;
  runId: string;
  clientSlug: string;
  input: Readonly<Record<string, unknown>>;
}

function describe(outcome: { status: string; reason?: string }): string {
  return "reason" in outcome && outcome.reason ? `${outcome.status}: ${outcome.reason}` : outcome.status;
}

/**
 * Reads a channel's stored charter.
 *
 * A missing `client.getStrategy` in the registry is treated as "no document",
 * not as a failure: the tool is optional in some compositions, and a pre-flight
 * that threw for a caller who simply never wired it would turn an additive
 * feature into a hard dependency.
 */
async function readCharter(
  args: ChannelSetupArgs,
  agent: string,
  key?: string,
): Promise<{ markdown: string; data?: Record<string, unknown> } | undefined> {
  const get = args.tools["client.getStrategy"];
  if (!get) return undefined;
  const outcome = await get.execute({ agent, ...(key ? { key } : {}) }, { ctx: args.ctx });
  if (outcome.status !== "success") return undefined;
  return outcome.result as { markdown: string; data?: Record<string, unknown> };
}

/**
 * LinkedIn: seats and the company page's standing direction.
 *
 * The probe is the AGENT-LEVEL document, not a seat's. A client with seats but
 * no company charter is a normal, fully-set-up state, and treating a
 * per-executive run as unconfigured because that one seat has no document would
 * re-run setup on every run for every seat the form never covered.
 */
export async function runLinkedInChannelSetup(args: ChannelSetupArgs): Promise<ChannelSetupOutcome> {
  const existing = await readCharter(args, "linkedin-agent");
  if (existing) {
    return {
      status: "already-configured",
      written: [],
      skipped: [],
      note: "this client already has a LinkedIn charter on file",
    };
  }

  const parsed = LinkedInSetupInputSchema.safeParse(args.input);
  const intake = parsed.success ? parsed.data : undefined;
  const hasForm = intake !== undefined && (intake.seats.length > 0 || Boolean(intake.companyUpdates?.trim()));
  if (!hasForm) {
    return {
      status: "not-supplied",
      written: [],
      skipped: [],
      note: parsed.success
        ? "no LinkedIn charter on file and this run carried no setup form"
        : `no LinkedIn charter on file and the setup fields on this run are not valid: ${parsed.error.message}`,
    };
  }

  const save = args.tools["intake.saveStrategy"];
  if (!save) {
    return {
      status: "not-supplied",
      written: [],
      skipped: [],
      // Not thrown: the drafting half of this run is still perfectly able to
      // proceed, and failing it over an unwired optional tool would turn a
      // missing convenience into a missing post.
      note: "a LinkedIn setup form arrived but intake.saveStrategy is not registered, so it could not be recorded",
    };
  }

  const written: string[] = [];
  const skipped: ChannelSetupOutcome["skipped"] = [];

  if (intake.companyUpdates?.trim()) {
    const outcome = await save.execute(
      {
        agent: "linkedin-agent",
        markdown: renderCompanyDoc(args.clientSlug, intake.companyUpdates),
        source: { form: "linkedin-setup", runId: args.runId, inline: true },
      },
      { ctx: args.ctx },
    );
    if (outcome.status === "success") written.push("strategy/linkedin-agent");
    else skipped.push({ key: "company", reason: describe(outcome) });
  }

  for (const seat of intake.seats) {
    const key = slugifySeat(seat.fullName);
    if (!key) {
      // The name becomes a path segment; one that slugifies to nothing would
      // write to the agent-level document and overwrite the company page.
      skipped.push({ key: seat.fullName, reason: "name does not produce a usable key" });
      continue;
    }
    const outcome = await save.execute(
      {
        agent: "linkedin-agent",
        key,
        markdown: renderSeatDoc(seat),
        source: { form: "linkedin-setup", runId: args.runId, seat: key, inline: true },
      },
      { ctx: args.ctx },
    );
    if (outcome.status === "success") written.push(`strategy/linkedin-agent/${key}`);
    else skipped.push({ key, reason: describe(outcome) });
  }

  // Six seats submitted and one malformed stores five, not zero — and the run
  // continues either way. A charter that failed to store is a worse post, not
  // no post, and the skipped list says which.
  return {
    status: written.length > 0 ? "recorded" : "not-supplied",
    written,
    skipped,
    note:
      written.length > 0
        ? `recorded ${written.length} LinkedIn document(s) from this run's setup form`
        : `a LinkedIn setup form arrived but nothing could be stored: ${skipped.map((s) => `${s.key} (${s.reason})`).join("; ")}`,
  };
}

/**
 * Reddit: which communities this client may post into, and how.
 *
 * Reddit is draft-only as a hard product rule and nothing here changes that.
 * This records where a human may later post from their own account; it grants
 * no posting capability, and none exists to grant.
 */
export async function runRedditChannelSetup(args: ChannelSetupArgs): Promise<RedditChannelSetupOutcome> {
  const existing = await readCharter(args, "reddit-agent", "config");
  const existingData = existing ? readRedditCharterData(existing.data) : undefined;

  const parsed = RedditSetupInputSchema.safeParse(args.input);
  // Normalised here rather than at read time so the stored document is the
  // canonical form and every later reader sees the same strings.
  const formSubreddits = parsed.success ? [...new Set(parsed.data.targetSubreddits.map(normalizeSubreddit).filter(Boolean))] : [];

  // A charter on file wins over anything on the run — with ONE exception: a
  // charter the engine derived for itself (`autoDerived`) is a placeholder
  // for the form nobody had filled in yet, so the first run that does carry
  // a filled form replaces it. A form-recorded charter is never overwritten
  // here; a drafting run is not where a client's allowlist gets rewritten.
  if (existing && !(existingData?.autoDerived === true && formSubreddits.length > 0)) {
    // The structured half, when the document has one. A charter written before
    // `data` existed still counts as configured — it just cannot hand the
    // intake check a list, which is exactly what that check's own fallback to
    // `client.getConfig` is for.
    const targetSubreddits = existingData?.targetSubreddits ?? [];
    return {
      status: "already-configured",
      written: [],
      skipped: [],
      targetSubreddits,
      ...(existingData ? { charter: existingData } : {}),
      note: `this client already has a Reddit charter on file${targetSubreddits.length > 0 ? ` (${targetSubreddits.length} communities${existingData?.autoDerived ? ", auto-derived" : ""})` : ""}`,
    };
  }

  if (!parsed.success) {
    return {
      status: "not-supplied",
      written: [],
      skipped: [],
      targetSubreddits: [],
      note: "no Reddit charter on file and this run carried no usable setup form",
    };
  }

  const targetSubreddits = formSubreddits;
  if (targetSubreddits.length === 0) {
    return {
      status: "not-supplied",
      written: [],
      skipped: [],
      targetSubreddits: [],
      note: "a Reddit setup form arrived but none of its subreddit names were usable",
    };
  }

  const intake: RedditSetupInput = { ...parsed.data, targetSubreddits };
  const save = args.tools["intake.saveStrategy"];
  if (!save) {
    // The list is still returned: this run can use what the form said even
    // though nothing could persist it for the next one.
    return {
      status: "not-supplied",
      written: [],
      skipped: [],
      targetSubreddits,
      note: "a Reddit setup form arrived but intake.saveStrategy is not registered, so it could not be recorded",
    };
  }

  const data: RedditCharterData = {
    targetSubreddits,
    ...(intake.accountName ? { accountName: intake.accountName } : {}),
    ...(intake.offLimitsTopics.length > 0 ? { offLimitsTopics: intake.offLimitsTopics } : {}),
    ...(intake.voiceNotes?.trim() ? { voiceNotes: intake.voiceNotes.trim() } : {}),
  };
  const outcome = await save.execute(
    {
      agent: "reddit-agent",
      key: "config",
      markdown: renderConfigDoc(args.clientSlug, intake),
      // Both halves, written together. The markdown is what a model reads; the
      // data is what `00-intake-check` compares against.
      data: { ...data },
      source: { form: "reddit-setup", runId: args.runId, inline: true, ...(existingData?.autoDerived ? { replacedAutoDerived: true } : {}) },
    },
    { ctx: args.ctx },
  );

  if (outcome.status !== "success") {
    return {
      status: "not-supplied",
      written: [],
      skipped: [{ key: "config", reason: describe(outcome) }],
      targetSubreddits,
      note: `a Reddit setup form arrived but its config could not be stored: ${describe(outcome)}`,
    };
  }

  return {
    status: "recorded",
    written: ["strategy/reddit-agent/config"],
    skipped: [],
    targetSubreddits,
    charter: data,
    note: `recorded ${targetSubreddits.length} Reddit communities from this run's setup form${existingData?.autoDerived ? ", replacing the auto-derived charter" : ""}`,
  };
}

/** The structured half of a stored Reddit charter, read defensively — a document written before `data` existed has none. */
function readRedditCharterData(data: Record<string, unknown> | undefined): RedditCharterData | undefined {
  if (!data) return undefined;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : []);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);
  const targetSubreddits = strings(data["targetSubreddits"]);
  const offLimitsTopics = strings(data["offLimitsTopics"]);
  const searchKeywords = strings(data["searchKeywords"]);
  return {
    targetSubreddits,
    ...(str(data["accountName"]) ? { accountName: str(data["accountName"])! } : {}),
    ...(offLimitsTopics.length > 0 ? { offLimitsTopics } : {}),
    ...(searchKeywords.length > 0 ? { searchKeywords } : {}),
    ...(str(data["voiceNotes"]) ? { voiceNotes: str(data["voiceNotes"])! } : {}),
    ...(str(data["disclosureLine"]) ? { disclosureLine: str(data["disclosureLine"])! } : {}),
    ...(data["autoDerived"] === true ? { autoDerived: true } : {}),
  };
}

/** What the engine decided for a client with no Reddit charter — see `recordRedditAutoCharter`. */
export interface RedditAutoCharterInput {
  targetSubreddits: { name: string; why: string }[];
  searchKeywords: string[];
  offLimitsTopics: string[];
  voiceNotes: string;
  disclosureLine: string;
}

/**
 * Records an ENGINE-DERIVED Reddit charter for a client that has none.
 *
 * This is the one place a charter is written from something other than a
 * person's form, and the document says so on every line that matters: the
 * markdown carries an "auto-derived" banner, `data.autoDerived` is true, and
 * `source.form` is `reddit-auto-setup`. `runRedditChannelSetup` treats such a
 * charter as replaceable by the first real form, and only such a charter.
 *
 * Still code, still not a model: the deciding was done by the caller's
 * planner step. This function only stores the decision, normalising the
 * community names the same way the form path does so every later reader sees
 * one spelling. It never overwrites a charter that already exists.
 */
export async function recordRedditAutoCharter(args: ChannelSetupArgs, plan: RedditAutoCharterInput): Promise<RedditChannelSetupOutcome> {
  const existing = await readCharter(args, "reddit-agent", "config");
  if (existing) {
    const data = readRedditCharterData(existing.data);
    return {
      status: "already-configured",
      written: [],
      skipped: [],
      targetSubreddits: data?.targetSubreddits ?? [],
      ...(data ? { charter: data } : {}),
      note: "a Reddit charter already exists; the auto-derived plan was not written",
    };
  }

  const communities = plan.targetSubreddits
    .map((c) => ({ ...c, name: normalizeSubreddit(c.name) }))
    .filter((c, i, all) => c.name.length > 0 && all.findIndex((o) => o.name === c.name) === i);
  const targetSubreddits = communities.map((c) => c.name);
  if (targetSubreddits.length === 0) {
    return { status: "not-supplied", written: [], skipped: [], targetSubreddits: [], note: "the auto-derived plan named no usable communities" };
  }

  const save = args.tools["intake.saveStrategy"];
  if (!save) {
    return {
      status: "not-supplied",
      written: [],
      skipped: [],
      targetSubreddits,
      note: "an auto-derived Reddit charter was planned but intake.saveStrategy is not registered, so it could not be recorded",
    };
  }

  const searchKeywords = [...new Set(plan.searchKeywords.map((k) => k.trim()).filter(Boolean))];
  const data: RedditCharterData = {
    targetSubreddits,
    searchKeywords,
    ...(plan.offLimitsTopics.length > 0 ? { offLimitsTopics: plan.offLimitsTopics } : {}),
    voiceNotes: plan.voiceNotes.trim(),
    disclosureLine: plan.disclosureLine.trim(),
    autoDerived: true,
  };
  const lines = [
    `# Reddit setup — ${args.clientSlug}`,
    "",
    "> AUTO-DERIVED by the engine from the client's profile, brand kit and knowledge base, because no Reddit setup form had been filled in.",
    "> A filled setup form replaces this document on the next run.",
    "> Draft-only: one run drafts ONE reply, and a human posts it from their own account.",
    "",
    "**Communities.**",
    ...communities.map((c) => `- ${c.name} — ${c.why}`),
    "",
    "**Look for threads about.**",
    ...searchKeywords.map((k) => `- ${k}`),
    "",
    "**Voice.**",
    "",
    data.voiceNotes!,
    "",
    `**Disclosure line.** ${data.disclosureLine}`,
    "",
  ];
  if (data.offLimitsTopics && data.offLimitsTopics.length > 0) {
    lines.push("**Never engage on.**", ...data.offLimitsTopics.map((t) => `- ${t}`), "");
  }

  const outcome = await save.execute(
    {
      agent: "reddit-agent",
      key: "config",
      markdown: lines.join("\n"),
      data: { ...data },
      source: { form: "reddit-auto-setup", runId: args.runId, inline: true },
    },
    { ctx: args.ctx },
  );
  if (outcome.status !== "success") {
    return {
      status: "not-supplied",
      written: [],
      skipped: [{ key: "config", reason: describe(outcome) }],
      targetSubreddits,
      charter: data,
      note: `the auto-derived Reddit charter could not be stored: ${describe(outcome)}`,
    };
  }
  return {
    status: "recorded",
    written: ["strategy/reddit-agent/config"],
    skipped: [],
    targetSubreddits,
    charter: data,
    note: `recorded an auto-derived Reddit charter with ${targetSubreddits.length} communities`,
  };
}

/**
 * Drops communities from an AUTO-DERIVED charter that Reddit itself says do
 * not exist (a 404/403 on the community's feed), so a planner's wrong guess
 * is corrected on the run that discovers it rather than re-scanned forever.
 * A form-recorded charter is left alone: a person named those communities.
 * Best-effort — a failed rewrite leaves the stored charter as it was, and a
 * prune that would empty the list is refused (a charter with no communities
 * is worse than one with a wrong one).
 */
export async function pruneAutoDerivedSubreddits(args: ChannelSetupArgs, missing: readonly string[]): Promise<{ pruned: string[]; remaining: string[] }> {
  const existing = await readCharter(args, "reddit-agent", "config");
  const data = existing ? readRedditCharterData(existing.data) : undefined;
  if (!existing || !data || data.autoDerived !== true || missing.length === 0) {
    return { pruned: [], remaining: data?.targetSubreddits ?? [] };
  }
  const gone = new Set(missing.map(normalizeSubreddit));
  const remaining = data.targetSubreddits.filter((s) => !gone.has(s));
  const pruned = data.targetSubreddits.filter((s) => gone.has(s));
  if (pruned.length === 0 || remaining.length === 0) return { pruned: [], remaining: data.targetSubreddits };

  const save = args.tools["intake.saveStrategy"];
  if (!save) return { pruned: [], remaining: data.targetSubreddits };
  const markdown = existing.markdown
    .split("\n")
    .filter((line) => !pruned.some((s) => line.startsWith(`- ${s} `) || line.trim() === `- ${s}`))
    .join("\n");
  const outcome = await save.execute(
    {
      agent: "reddit-agent",
      key: "config",
      markdown,
      data: { ...data, targetSubreddits: remaining },
      source: { form: "reddit-auto-setup", runId: args.runId, inline: true, prunedMissingCommunities: pruned },
    },
    { ctx: args.ctx },
  );
  return outcome.status === "success" ? { pruned, remaining } : { pruned: [], remaining: data.targetSubreddits };
}

/**
 * The seat charter, in the shape a drafting run expects to read.
 *
 * Markdown rather than JSON fields because that is what reaches the model:
 * `client.getStrategy` hands the whole document to the prompt, and a heading a
 * person wrote reads better there than a serialized object.
 */
function renderSeatDoc(seat: LinkedInSeatIntake): string {
  const lines = [`# LinkedIn seat — ${seat.fullName}`, "", "> Recorded from a filled portal form at run time.", ""];
  if (seat.role) lines.push(`**Role.** ${seat.role}`, "");
  if (seat.profileUrl) lines.push(`**Profile.** ${seat.profileUrl}`, "");
  if (seat.focusTopics.length > 0) {
    lines.push("**Known for.**", ...seat.focusTopics.map((t) => `- ${t}`), "");
  }
  if (seat.offLimitsTopics.length > 0) {
    // Kept as its own heading, and last-but-one, because this is the half a
    // drafting run has to honour rather than draw on.
    lines.push("**Never post.**", ...seat.offLimitsTopics.map((t) => `- ${t}`), "");
  }
  if (seat.voiceSample) {
    lines.push("**Voice sample.**", "", seat.voiceSample.trim(), "");
  }
  if (seat.cvPath) lines.push(`**CV on file.** ${seat.cvPath}`, "");
  return lines.join("\n");
}

function renderCompanyDoc(clientSlug: string, direction: string): string {
  return [
    `# LinkedIn company page — ${clientSlug}`,
    "",
    "> Standing direction for the company page, recorded from a filled portal form at run time.",
    "",
    direction.trim(),
    "",
  ].join("\n");
}

// Takes the schema's own inferred type rather than restating its shape: under
// exactOptionalPropertyTypes a hand-written `accountName?: string` is not the
// same type as one that may be explicitly undefined, and restating it is how
// the two drift.
function renderConfigDoc(clientSlug: string, intake: RedditSetupInput): string {
  const lines = [
    `# Reddit setup — ${clientSlug}`,
    "",
    "> Recorded from a filled portal form at run time.",
    "> Draft-only: one run drafts ONE reply, and a human posts it from their own account.",
    "",
    "**Communities.**",
    ...intake.targetSubreddits.map((s) => `- ${s}`),
    "",
  ];
  if (intake.accountName) lines.push(`**Account.** ${intake.accountName}`, "");
  if (intake.voiceNotes) lines.push("**Voice.**", "", intake.voiceNotes.trim(), "");
  if (intake.offLimitsTopics.length > 0) {
    lines.push("**Never engage on.**", ...intake.offLimitsTopics.map((t) => `- ${t}`), "");
  }
  return lines.join("\n");
}
