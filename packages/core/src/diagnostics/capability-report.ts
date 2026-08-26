import {
  CAPABILITY_CATALOGUE,
  type CapabilityDecision,
  type CapabilityDefinition,
  type CapabilityStatus,
} from "./capability-catalogue.js";

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
    /** The number that matters: absences nobody has explained. */
    readonly unexplained: number;
    /** Absent checks. Reported apart from degradations because they are a different kind of thing. */
    readonly securityGaps: number;
  };
  readonly capabilities: readonly CapabilityRow[];
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
  if (requiredMissing || !anyAlternative) {
    status = "DISABLED";
  } else if (missingThatCosts.length > 0) {
    status = "DEGRADED";
  } else {
    status = "ACTIVE";
  }

  // A fully-configured capability is never an open question, whatever its
  // rationale says. Only an actual absence needs a recorded decision.
  const decision: CapabilityDecision = status === "ACTIVE" || capability.rationale !== undefined ? "EXPECTED" : "UNEXPLAINED";

  return {
    id: capability.id,
    title: capability.title,
    owner: capability.owner,
    status,
    decision,
    security: capability.security === true,
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
  return score;
}

export function buildCapabilityReport(
  env: Record<string, string | undefined> = process.env,
  now: () => Date = () => new Date(),
): CapabilityReport {
  const rows = CAPABILITY_CATALOGUE.map((c) => evaluate(c, env)).sort((a, b) => severity(a) - severity(b) || a.title.localeCompare(b.title));

  return {
    // Same prep/prod signal the tracer and the auth config already use, rather
    // than a third environment variable that could disagree with them.
    environment: env["FIRESTORE_DATABASE_ID"] === "prep" ? "prep" : "prod",
    generatedAt: now().toISOString(),
    summary: {
      active: rows.filter((r) => r.status === "ACTIVE").length,
      degraded: rows.filter((r) => r.status === "DEGRADED").length,
      disabled: rows.filter((r) => r.status === "DISABLED").length,
      unexplained: rows.filter((r) => r.decision === "UNEXPLAINED").length,
      securityGaps: rows.filter((r) => r.security && r.status !== "ACTIVE").length,
    },
    capabilities: rows,
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
  const disabled = relevant.filter((c) => c.status === "DISABLED");
  const degraded = relevant.filter((c) => c.status === "DEGRADED");

  const tier: RunCapabilityTier = disabled.length > 0 ? "UNAVAILABLE" : degraded.length > 0 ? "ESTIMATED" : "MEASURED";

  const affected = [...disabled, ...degraded];
  return {
    tier,
    degraded: affected.map((c) => c.id),
    notes: affected.map((c) => `${c.title} — ${c.status} (missing ${c.missing.join(", ")}): ${c.whenAbsent}`),
  };
}
