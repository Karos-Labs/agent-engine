import { z } from "zod";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { CaptureLegRequestSchema, type CaptureLegRequest, type DiscoverGbpLocationsResult } from "@agent-engine/tool-karos-reputation";
import { parseReputationClientConfig } from "./intake.js";

/**
 * ── 00-roster-setup: the reputation agent's own onboarding, as a pre-flight ──
 *
 * The lab's `karos-reputation-setup` skill was a separate job someone had to
 * remember to run before the first pulse, and its single hard gate was the
 * roster: "at least one review surface is confirmed to exist and to belong to
 * this business. No surface, no product." On the engine that job never
 * existed at all — the pulse read `reputationRoster` off client config, nothing
 * ever wrote it, and every first run for every client ended at step 03 with
 * "no reputation capture legs are configured".
 *
 * This is the same shape `linkedin-agent`/`reddit-agent` chose for the same
 * problem (`agents/setup-agents/src/workflow/channel-setup.ts`): the pulse
 * checks its own roster first, resolves one from what the run carried if there
 * is none, records it, and continues. A client with a roster pays one config
 * read. A client without one never learns that "setup" happened — the first
 * pulse simply works, or says exactly which named surface it could not turn
 * into a listing and why.
 *
 * ## What this resolves, and what it refuses to guess
 *
 * The portal's intake asks the client where they THINK they are reviewed
 * (`reviewSurfaces`), which the lab skill treats as a seed, not the roster:
 * "resolve that to real listings per surface and market... a wrong listing
 * means drafting replies to another business's customers." So:
 *
 *  - A structured `reputationRoster` on the run input is taken as-is (an
 *    operator or a portal that already knows the ids).
 *  - An App Store URL carries its own app id, so it resolves without a lookup.
 *  - A Google surface resolves ONLY through the account the client owns
 *    (`gbpAccountId` in client config or on the run): the account's locations
 *    are enumerated, never searched for by name. No account, no Google leg,
 *    and the reason says so.
 *  - Every other surface (Yelp, Trustpilot, TripAdvisor, ...) has no capture
 *    adapter yet; it is recorded as skipped with that reason rather than
 *    silently dropped, because the client named it and will look for it.
 *
 * ## Still code, still not a model
 *
 * Same rule as the LinkedIn/Reddit pre-flights: a setup step records what a
 * person said and what an owned account contains. A model in this path could
 * only paraphrase the first and invent the second.
 */

/** What the pre-flight decided, recorded on the step so a run says which path it took. */
export interface RosterSetupOutcome {
  /**
   * - `already-configured` — client config carried a roster; nothing was written.
   * - `recorded` — this run resolved one or more listings and stored them.
   * - `not-supplied` — no roster and nothing resolvable arrived with the run.
   */
  status: "already-configured" | "recorded" | "not-supplied";
  /** Listings now on file (standing or newly recorded). */
  legCount: number;
  /** Where each recorded leg came from, one line per source, for the trace. */
  resolvedFrom: string[];
  /** Surfaces the client named that did not become a listing, and why — never silently dropped. */
  skipped: { seed: string; reason: string }[];
  /** Config keys written by THIS run. Empty unless `recorded`. */
  written: string[];
  /** One line for the trace and for step 03's refusal, so the client reads the cause rather than "empty". */
  note: string;
}

export interface RosterSetupArgs {
  tools: AgentToolRegistry;
  ctx: AgentContext;
  runId: string;
  clientSlug: string;
  /** The run's input envelope (`wf.input`), which the portal fills from the client's reputation intake. */
  input: Readonly<Record<string, unknown>>;
}

/**
 * The run-input keys this pre-flight reads. Named here, once, because the
 * portal's `submit-custom.ts` fills them from the client's intake form and the
 * two sides have to agree on spelling.
 */
export const ROSTER_SETUP_INPUT_KEYS = {
  /** A structured `CaptureLegRequest[]`, for callers that already know the ids. */
  roster: "reputationRoster",
  /** Free-text surfaces the client named — URLs or platform names, one per entry. */
  surfaces: "reviewSurfaces",
  /** Locations/markets the client named; recorded as provenance, not used to resolve. */
  markets: "reviewMarkets",
  /** Claims a public reply may never make; becomes `reputationLocks.neverSay` when none is on file. */
  noGos: "responseNoGos",
  /** Who hears about an urgent review; recorded as provenance. */
  crisisRouting: "crisisRoutingTag",
  /** Standing background the client wrote; recorded as provenance. */
  context: "reputationContext",
  /** A Google Business Profile account id, when the client supplies one on the run rather than in config. */
  gbpAccount: "gbpAccountId",
} as const;

/** A list field as the portal may send it: an array, or one string with entries on separate lines or after commas. */
function readList(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : typeof value === "string"
      ? value.split(/[\n,]/)
      : [];
  return [...new Set(raw.map((v) => v.trim()).filter((v) => v.length > 0))];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * `https://apps.apple.com/gb/app/acme-coffee/id123456789` (the slug and the
 * storefront are both optional in real links) or a bare `id123456789`.
 */
const APP_STORE_URL = /apps\.apple\.com\/(?:([a-z]{2})\/)?app\/(?:([^/\s?]+)\/)?id(\d{5,})/i;
const APP_STORE_BARE = /^(?:app\s*store\s*[:#-]?\s*)?id(\d{5,})$/i;

/** Google Play is Google, but it is not a Business Profile — matched before the GBP test so it lands on "no adapter" rather than "no account". */
const NO_ADAPTER_SURFACE =
  /yelp|trustpilot|tripadvisor|facebook\.com|fb\.com|glassdoor|g2\.com|capterra|indeed|booking\.com|expedia|play\.google|healthgrades|zocdoc|houzz|angi\b|bbb\.org|amazon/i;
const GOOGLE_SURFACE = /google|gbp|g\.page|goo\.gl|maps\.app/i;

type SeedResolution =
  | { kind: "appstore"; leg: CaptureLegRequest }
  | { kind: "google" }
  | { kind: "skipped"; reason: string };

function resolveSeed(seed: string): SeedResolution {
  const url = APP_STORE_URL.exec(seed);
  if (url) {
    const [, country, slug, appId] = url;
    return {
      kind: "appstore",
      leg: {
        leg: "appstore",
        listingId: `appstore:${appId}`,
        listingLabel: slug ? `${slug.replace(/-/g, " ")} (App Store)` : `App Store app ${appId}`,
        inRoster: true,
        appId: appId!,
        country: (country ?? "us").toLowerCase(),
        maxPages: 10,
      },
    };
  }
  const bareId = APP_STORE_BARE.exec(seed);
  if (bareId) {
    const appId = bareId[1]!;
    return {
      kind: "appstore",
      leg: { leg: "appstore", listingId: `appstore:${appId}`, listingLabel: `App Store app ${appId}`, inRoster: true, appId, country: "us", maxPages: 10 },
    };
  }
  if (/app\s*store|apple/i.test(seed)) {
    return { kind: "skipped", reason: "an App Store surface needs the app's URL (or its id) — the name alone does not say which app" };
  }
  if (NO_ADAPTER_SURFACE.test(seed)) {
    return { kind: "skipped", reason: "no capture adapter exists for this surface yet; a manual export is the floor for it (ADAPTERS.md)" };
  }
  if (GOOGLE_SURFACE.test(seed)) return { kind: "google" };
  return { kind: "skipped", reason: "not a review surface this agent can read" };
}

function legKey(leg: CaptureLegRequest): string {
  return `${leg.leg}:${leg.listingId}`;
}

function describeSkipped(skipped: RosterSetupOutcome["skipped"]): string {
  return skipped.map((s) => `${s.seed} (${s.reason})`).join("; ");
}

export async function runReputationRosterSetup(args: RosterSetupArgs): Promise<RosterSetupOutcome> {
  const { tools, ctx, input } = args;

  // ── the probe: is there a roster already? ──
  const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
  const config = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
  const standing = parseReputationClientConfig(config);
  if (standing.captureLegs.length > 0) {
    return {
      status: "already-configured",
      legCount: standing.captureLegs.length,
      resolvedFrom: [],
      skipped: [],
      written: [],
      note: `this client already has a reputation roster on file (${standing.captureLegs.length} listing${standing.captureLegs.length === 1 ? "" : "s"})`,
    };
  }
  if (standing.rosterConfigError) {
    // A roster that exists but does not parse is a config bug someone has to
    // look at. Writing over it from a setup pass would hide the bug and could
    // discard listings a person confirmed by hand — step 03 reports the parse
    // error, which is the honest outcome.
    return {
      status: "already-configured",
      legCount: 0,
      resolvedFrom: [],
      skipped: [],
      written: [],
      note: `this client's reputationRoster is on file but does not parse, so setup left it alone: ${standing.rosterConfigError}`,
    };
  }

  // ── resolve: what did this run carry? ──
  const legs = new Map<string, CaptureLegRequest>();
  const resolvedFrom: string[] = [];
  const skipped: RosterSetupOutcome["skipped"] = [];
  const add = (leg: CaptureLegRequest) => {
    if (!legs.has(legKey(leg))) legs.set(legKey(leg), leg);
  };

  const rosterRaw = input[ROSTER_SETUP_INPUT_KEYS.roster];
  if (rosterRaw !== undefined) {
    const parsed = z.array(CaptureLegRequestSchema).safeParse(rosterRaw);
    if (parsed.success && parsed.data.length > 0) {
      for (const leg of parsed.data) add(leg);
      resolvedFrom.push(`${parsed.data.length} listing(s) supplied on the run as reputationRoster`);
    } else if (!parsed.success) {
      skipped.push({ seed: ROSTER_SETUP_INPUT_KEYS.roster, reason: `the run's reputationRoster does not parse: ${parsed.error.message}` });
    }
  }

  const seeds = readList(input[ROSTER_SETUP_INPUT_KEYS.surfaces]);
  const googleSeeds: string[] = [];
  for (const seed of seeds) {
    const resolution = resolveSeed(seed);
    if (resolution.kind === "appstore") {
      add(resolution.leg);
      resolvedFrom.push(`"${seed}" → App Store app ${resolution.leg.listingId.slice("appstore:".length)}`);
    } else if (resolution.kind === "google") {
      googleSeeds.push(seed);
    } else {
      skipped.push({ seed, reason: resolution.reason });
    }
  }

  // Google resolves through the OWNED account, whether the client named Google
  // as a surface or only left the account id in config. Both are the client
  // telling us the listing is theirs; neither is a search.
  const gbpAccount = readString(config["gbpAccountId"]) ?? readString(input[ROSTER_SETUP_INPUT_KEYS.gbpAccount]);
  if (googleSeeds.length > 0 || (gbpAccount && seeds.length === 0 && rosterRaw === undefined)) {
    const seedLabel = googleSeeds[0] ?? "Google Business Profile";
    if (!gbpAccount) {
      skipped.push({
        seed: seedLabel,
        reason: "no Google Business Profile account id on file (client config gbpAccountId) — listings are enumerated from the owned account, never searched for by name",
      });
    } else {
      const discover = tools["reputation.discoverGbpLocations"];
      if (!discover) {
        skipped.push({ seed: seedLabel, reason: "reputation.discoverGbpLocations is not registered, so the account's listings could not be enumerated" });
      } else {
        const outcome = await discover.execute({ account: gbpAccount }, { ctx });
        if (outcome.status !== "success") {
          const reason = "reason" in outcome && typeof outcome.reason === "string" ? outcome.reason : outcome.status;
          skipped.push({ seed: seedLabel, reason });
        } else {
          const { account, locations } = outcome.result as DiscoverGbpLocationsResult;
          if (locations.length === 0) {
            skipped.push({ seed: seedLabel, reason: `Google Business Profile account "${account}" has no locations` });
          } else {
            for (const location of locations) {
              add({
                leg: "gbp",
                listingId: `gbp:${location.location}`,
                listingLabel: location.address ? `${location.title} — ${location.address}` : location.title,
                inRoster: true,
                account,
                location: location.location,
              });
            }
            resolvedFrom.push(`Google Business Profile account "${account}" → ${locations.length} location(s)`);
          }
        }
      }
    }
  }

  if (legs.size === 0) {
    const note =
      seeds.length === 0 && rosterRaw === undefined && !gbpAccount
        ? "no roster on file and this run named no review surfaces — the reputation intake's \"where people review you\" is what this resolves from"
        : `no roster on file and none of the named surfaces resolved to a listing: ${describeSkipped(skipped)}`;
    return { status: "not-supplied", legCount: 0, resolvedFrom, skipped, written: [], note };
  }

  // ── record ──
  const save = tools["reputation.saveRoster"];
  if (!save) {
    return {
      status: "not-supplied",
      legCount: 0,
      resolvedFrom,
      skipped,
      written: [],
      // Not thrown: the pulse still cannot capture without a roster, and step
      // 03 will say so; this line says WHY the resolved listings went nowhere.
      note: `resolved ${legs.size} listing(s) but reputation.saveRoster is not registered, so nothing could be recorded`,
    };
  }

  const noGos = readList(input[ROSTER_SETUP_INPUT_KEYS.noGos]);
  const markets = readList(input[ROSTER_SETUP_INPUT_KEYS.markets]);
  const crisisRouting = readString(input[ROSTER_SETUP_INPUT_KEYS.crisisRouting]);
  const context = readString(input[ROSTER_SETUP_INPUT_KEYS.context]);
  const roster = [...legs.values()];

  const outcome = await save.execute(
    {
      roster,
      ...(noGos.length > 0 ? { locks: { neverSay: noGos, requiredFramingAnyOf: [] } } : {}),
      setup: {
        seeds,
        ...(markets.length > 0 ? { markets } : {}),
        ...(crisisRouting ? { crisisRouting } : {}),
        ...(context ? { context } : {}),
        resolvedFrom,
        skipped,
      },
    },
    { ctx },
  );
  if (outcome.status !== "success") {
    const reason = "reason" in outcome && typeof outcome.reason === "string" ? outcome.reason : outcome.status;
    return {
      status: "not-supplied",
      legCount: 0,
      resolvedFrom,
      skipped: [...skipped, { seed: "client/config", reason }],
      written: [],
      note: `resolved ${roster.length} listing(s) but they could not be recorded: ${reason}`,
    };
  }

  const wrote = (outcome.result as { wrote: string[] }).wrote;
  return {
    status: "recorded",
    legCount: roster.length,
    resolvedFrom,
    skipped,
    written: wrote.map((key) => `client/config#${key}`),
    note:
      `resolved ${roster.length} listing(s) from ${resolvedFrom.join("; ")} and recorded them for every later pulse` +
      (skipped.length > 0 ? `; could not resolve: ${describeSkipped(skipped)}` : ""),
  };
}
