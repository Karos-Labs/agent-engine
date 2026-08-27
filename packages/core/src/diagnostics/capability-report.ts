import {
  CAPABILITY_CATALOGUE,
  type CapabilityDecision,
  type CapabilityDefinition,
  type CapabilityStatus,
} from "./capability-catalogue.js";
import { PRODUCT_CAPABILITIES, type ProductCapabilities } from "./capability-products.js";

/**
 * Evaluates the capability catalogue against one environment (AU55 /
 * SCRUM-354).
 *
 * The output answers one question per row: is this switched off, what does it
 * cost, and did anyone decide that. Rows a person has to act on sort first —
 * UNEXPLAINED absences ahead of expected ones, security holes ahead of
 * degradations — because a key absent with no recorded reason is a question
 * nobody has been asked yet.
 */
export interface CapabilityRow {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly status: CapabilityStatus;
  readonly decision: CapabilityDecision;
  /** Absences that remove a check rather than a feature. */
  readonly security: boolean;
  /** A short phrase naming what is LACKING, for a product headline. */
  readonly shortfall?: string;
  /** Set when this is scheduled work rather than a configuration gap. */
  readonly pendingBuild?: { readonly ticket: string; readonly summary: string };
  /** Which variables are missing, by role. Empty when nothing is missing. */
  readonly missing: readonly string[];
  readonly present: readonly string[];
  /** What the system does instead. The field a decision is actually made from. */
  readonly whenAbsent: string;
  readonly rationale?: string;
}

export interface CapabilityReport {
  readonly environment: string;
  readonly generatedAt: string;
  readonly summary: {
    readonly active: number;
    readonly degraded: number;
    readonly disabled: number;
    /** Decided, not yet built. Reported apart from `disabled` because no key fixes it. */
    readonly pendingBuild: number;
    /** The number that matters: absences nobody has explained. */
    readonly unexplained: number;
    /** Absent checks. Reported apart from degradations because they are a different kind of thing. */
    readonly securityGaps: number;
  };
  readonly capabilities: readonly CapabilityRow[];
  /**
   * The same rows, rolled up to the altitude decisions are made at (the capability-by-product work).
   * Sorted worst-first, so the one line anyone needs is the first line.
   */
  readonly products: readonly ProductRow[];
}

/**
 * Whether a product can produce its deliverable in THIS environment (the capability-by-product work).
 *
 * Deliberately three values, not four. `PENDING_BUILD` is a capability-level
 * distinction — it tells you no key will fix it — but at product level the
 * only thing anyone needs first is "can it run". Why it cannot run belongs in
 * `blockedReason` and the headline, not in a fourth status people have to
 * learn.
 */
export type ProductStatus =
  /** Everything it requires is satisfied. */
  | "RUNNABLE"
  /** It runs and ships, with less coverage or lower quality than fully configured. */
  | "DEGRADED"
  /** It cannot produce its deliverable at all. */
  | "UNRUNNABLE";

/** Why an UNRUNNABLE product is unrunnable — the distinction that decides who acts. */
export type ProductBlockedReason =
  /** Someone must issue a key or fix a deploy config. */
  | "NOT_CONFIGURED"
  /** Nobody can fix it by configuring anything; the work is scheduled and unbuilt. */
  | "PENDING_DEVELOPMENT";

export interface ProductRow {
  readonly productId: string;
  readonly title: string;
  readonly status: ProductStatus;
  readonly blockedReason?: ProductBlockedReason;
  /**
   * The whole point of this layer, pre-rendered so every consumer says the
   * same sentence: `branded-shorts-agent: UNRUNNABLE — render engine pending
   * development (SCRUM-362)`.
   */
  readonly headline: string;
  /** Capability ids that make it unrunnable. */
  readonly blockedBy: readonly string[];
  /** Capability ids that cost coverage or quality without stopping it. */
  readonly degradedBy: readonly string[];
  /** The per-key detail, kept underneath. It is correct; it is just not the level anyone decides at. */
  readonly capabilities: readonly CapabilityRow[];
}

/** A capability's own phrase for what it lacks, falling back to something usable rather than nothing. */
function shortfallOf(row: CapabilityRow): string {
  return row.pendingBuild?.summary ?? row.shortfall ?? `${row.id} unavailable`;
}

function rollUp(product: ProductCapabilities, byId: ReadonlyMap<string, CapabilityRow>): ProductRow {
  const lookup = (ids: readonly string[]): CapabilityRow[] => ids.map((id) => byId.get(id)).filter((r): r is CapabilityRow => r !== undefined);

  const required = lookup(product.requires);
  const enhancing = lookup(product.enhances);

  const blocking = required.filter((r) => r.status !== "ACTIVE");
  const degrading = enhancing.filter((r) => r.status === "DEGRADED" || r.status === "DISABLED" || r.status === "PENDING_BUILD");

  const status: ProductStatus = blocking.length > 0 ? "UNRUNNABLE" : degrading.length > 0 ? "DEGRADED" : "RUNNABLE";

  // PENDING_DEVELOPMENT wins when ANY blocker is unbuilt, even alongside
  // configuration gaps. Reporting branded-shorts as NOT_CONFIGURED because a
  // key is also missing would send someone to issue a key that changes nothing.
  const pending = blocking.filter((r) => r.status === "PENDING_BUILD");
  const blockedReason: ProductBlockedReason | undefined =
    status !== "UNRUNNABLE" ? undefined : pending.length > 0 ? "PENDING_DEVELOPMENT" : "NOT_CONFIGURED";

  const tickets = [...new Set(pending.map((r) => r.pendingBuild!.ticket))];
  const reasons = (blockedReason === "PENDING_DEVELOPMENT" ? pending : blocking).map(shortfallOf);

  let headline: string;
  if (status === "UNRUNNABLE") {
    headline = `${product.productId}: UNRUNNABLE — ${[...new Set(reasons)].join("; ")}${tickets.length > 0 ? ` (${tickets.join(", ")})` : ""}`;
  } else if (status === "DEGRADED") {
    headline = `${product.productId}: DEGRADED — ${[...new Set(degrading.map(shortfallOf))].join("; ")}`;
  } else {
    headline = `${product.productId}: RUNNABLE`;
  }

  return {
    productId: product.productId,
    title: product.title,
    status,
    ...(blockedReason !== undefined ? { blockedReason } : {}),
    headline,
    blockedBy: blocking.map((r) => r.id),
    degradedBy: degrading.map((r) => r.id),
    capabilities: [...required, ...enhancing],
  };
}

/**
 * Worst first, and among equals the ones a person can actually fix first.
 * PENDING_DEVELOPMENT sorts BELOW NOT_CONFIGURED for the same reason
 * PENDING_BUILD scores nothing above: it is already on a board, and putting it
 * at the top of a list of things to go and fix wastes the only attention this
 * report gets.
 */
function productSeverity(row: ProductRow): number {
  if (row.status === "UNRUNNABLE") return row.blockedReason === "PENDING_DEVELOPMENT" ? -50 : -100;
  if (row.status === "DEGRADED") return -10;
  return 0;
}

function isSet(env: Record<string, string | undefined>, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim().length > 0;
}

/**
 * `AUTH_ENABLED=false` is a real value, not an absence — but the capability it
 * guards is still off. Treating "present but explicitly disabled" as satisfied
 * would report authentication as ACTIVE while it is switched off, which is the
 * exact species of false comfort this report exists to remove.
 */
function isEffectivelyOn(env: Record<string, string | undefined>, name: string): boolean {
  if (!isSet(env, name)) return false;
  const value = env[name]!.trim().toLowerCase();
  return value !== "false" && value !== "0";
}

function evaluate(capability: CapabilityDefinition, env: Record<string, string | undefined>): CapabilityRow {
  const present: string[] = [];
  const missing: string[] = [];

  for (const requirement of capability.requires) {
    const satisfied = requirement.kind === "required" ? isEffectivelyOn(env, requirement.name) : isSet(env, requirement.name);
    (satisfied ? present : missing).push(requirement.name);
  }

  const alternatives = capability.requires.filter((r) => r.kind === "alternative");
  const anyAlternative = alternatives.length === 0 || alternatives.some((r) => isSet(env, r.name));
  const requiredMissing = capability.requires.some((r) => r.kind === "required" && missing.includes(r.name));

  // An `alternative` that is unset while a sibling IS set has cost nothing —
  // that is what "alternative" means. Counting it as degradation reported
  // image generation as DEGRADED purely because it resolves its project id
  // from GOOGLE_CLOUD_PROJECT rather than GEMINI_VERTEX_PROJECT_ID, which is
  // the normal, intended configuration. Only `enhances` reflects a real loss.
  const missingThatCosts = missing.filter((name) => {
    const requirement = capability.requires.find((r) => r.name === name)!;
    return requirement.kind !== "alternative" || !anyAlternative;
  });

  let status: CapabilityStatus;
  if (capability.pendingBuild) {
    // Beats every configuration verdict, including ACTIVE. A variable can be
    // set and the capability still not exist — pointing BRANDED_SHORTS_ENGINE_DIR
    // at a directory does not create an engine. Reporting that as ACTIVE would
    // be the worst row in the table.
    status = "PENDING_BUILD";
  } else if (requiredMissing || !anyAlternative) {
    status = "DISABLED";
  } else if (missingThatCosts.length > 0) {
    status = "DEGRADED";
  } else {
    status = "ACTIVE";
  }

  // A fully-configured capability is never an open question, whatever its
  // rationale says. Only an actual absence needs a recorded decision.
  //
  // PENDING_BUILD is EXPECTED because `pendingBuild.ticket` is mandatory —
  // scheduled work IS a recorded decision. This is the one thing that must not
  // leak: UNEXPLAINED has to keep meaning exactly one thing, a question nobody
  // has been asked. Anything else in that list devalues the whole report.
  const decision: CapabilityDecision =
    status === "ACTIVE" || status === "PENDING_BUILD" || capability.rationale !== undefined ? "EXPECTED" : "UNEXPLAINED";

  return {
    id: capability.id,
    title: capability.title,
    owner: capability.owner,
    status,
    decision,
    security: capability.security === true,
    ...(capability.shortfall !== undefined ? { shortfall: capability.shortfall } : {}),
    ...(capability.pendingBuild !== undefined ? { pendingBuild: capability.pendingBuild } : {}),
    missing: missingThatCosts,
    present,
    whenAbsent: capability.whenAbsent,
    ...(capability.rationale !== undefined ? { rationale: capability.rationale } : {}),
  };
}

/** Act-on-me-first ordering: unexplained before expected, security before features, disabled before degraded. */
function severity(row: CapabilityRow): number {
  let score = 0;
  if (row.decision === "UNEXPLAINED") score -= 100;
  if (row.security && row.status !== "ACTIVE") score -= 50;
  if (row.status === "DISABLED") score -= 10;
  else if (row.status === "DEGRADED") score -= 5;
  // PENDING_BUILD scores nothing. It is not a thing to act on in this report —
  // it is a thing already on a board — and floating it up next to real gaps is
  // what made it read as an oversight in the first place.
  return score;
}

export function buildCapabilityReport(
  env: Record<string, string | undefined> = process.env,
  now: () => Date = () => new Date(),
): CapabilityReport {
  const rows = CAPABILITY_CATALOGUE.map((c) => evaluate(c, env)).sort((a, b) => severity(a) - severity(b) || a.title.localeCompare(b.title));
  const byId = new Map(rows.map((r) => [r.id, r]));

  return {
    // Same prep/prod signal the tracer and the auth config already use, rather
    // than a third environment variable that could disagree with them.
    environment: env["FIRESTORE_DATABASE_ID"] === "prep" ? "prep" : "prod",
    generatedAt: now().toISOString(),
    summary: {
      active: rows.filter((r) => r.status === "ACTIVE").length,
      degraded: rows.filter((r) => r.status === "DEGRADED").length,
      disabled: rows.filter((r) => r.status === "DISABLED").length,
      pendingBuild: rows.filter((r) => r.status === "PENDING_BUILD").length,
      unexplained: rows.filter((r) => r.decision === "UNEXPLAINED").length,
      securityGaps: rows.filter((r) => r.security && r.status !== "ACTIVE").length,
    },
    capabilities: rows,
    products: PRODUCT_CAPABILITIES.map((p) => rollUp(p, byId)).sort(
      (a, b) => productSeverity(a) - productSeverity(b) || a.productId.localeCompare(b.productId),
    ),
  };
}

/**
 * The capture-tier vocabulary, reused rather than paralleled (AU55): a run that
 * produced a deliverable with fewer sources than a fully-configured one should
 * be distinguishable afterwards, in the same words the SEO/GEO capture layer
 * already uses for the same idea.
 *
 * MEASURED  — every capability the run depended on was fully configured.
 * ESTIMATED — the run completed on fallbacks because something was absent.
 * UNAVAILABLE — a capability the run needed was off entirely.
 *
 * Deliberately NOT a hold. Degradation is usually fine; silence about it is not.
 */
export type RunCapabilityTier = "MEASURED" | "ESTIMATED" | "UNAVAILABLE";

export interface RunCapabilityNote {
  readonly tier: RunCapabilityTier;
  /** Capability ids that were not fully configured for this run. */
  readonly degraded: readonly string[];
  /** One line per degraded capability, in the same words the report uses. */
  readonly notes: readonly string[];
}

/**
 * Summarises, for one run, which of the capabilities it actually depended on
 * were degraded — so a client report built from three image providers is
 * distinguishable afterwards from one built from six.
 *
 * `dependsOn` is the caller's own list of capability ids: a blog run does not
 * become ESTIMATED because the video engine is unconfigured.
 */
export function describeRunCapabilities(dependsOn: readonly string[], report: CapabilityReport): RunCapabilityNote {
  const relevant = report.capabilities.filter((c) => dependsOn.includes(c.id));
  // PENDING_BUILD counts as UNAVAILABLE here, not as a fourth tier: from the
  // run's point of view the capability was not there, and why it was not there
  // is the report's business rather than this note's.
  const disabled = relevant.filter((c) => c.status === "DISABLED" || c.status === "PENDING_BUILD");
  const degraded = relevant.filter((c) => c.status === "DEGRADED");

  const tier: RunCapabilityTier = disabled.length > 0 ? "UNAVAILABLE" : degraded.length > 0 ? "ESTIMATED" : "MEASURED";

  const affected = [...disabled, ...degraded];
  return {
    tier,
    degraded: affected.map((c) => c.id),
    notes: affected.map((c) => `${c.title} — ${c.status} (missing ${c.missing.join(", ")}): ${c.whenAbsent}`),
  };
}
