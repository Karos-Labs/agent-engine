import { z } from "zod";
import { CaptureLegRequestSchema, TriageConfigSchema, type CaptureLegRequest, type TriageConfig } from "@agent-engine/tool-karos-reputation";
import type { ClientLocks } from "./client-lock.js";

/**
 * The reputation-specific slice of `client.getConfig()`'s free-form record
 * (RFC-08 task spec — no canonical client-config schema exists anywhere in
 * this repo yet, per every other `karos-client` tool's own "loose shape, no
 * admin-authoring system wired up" comment). Every field here is read
 * defensively field-by-field, not as one big `safeParse` of the whole
 * object: an unrelated or malformed field elsewhere in a client's config
 * must never block a run that never touched it.
 */
export interface ParsedReputationConfig {
  captureLegs: CaptureLegRequest[];
  /** Present only when `reputationRoster` existed but failed its own schema — surfaced so `WorkflowBlockedIntake`'s reason names the real problem instead of just "empty." */
  rosterConfigError?: string;
  locks: ClientLocks;
  /** Read as a free-form string and asserted against `"approve-all"` at step 10, never trusted as already-validated (RFC-08 §6: no other value is legal today). */
  autonomy: string;
  baselineRatingAvg: Record<string, number>;
  triageConfigOverride?: TriageConfig;
  steer: Record<string, unknown>;
  pulseNumber?: number;
}

function safeField<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

export function parseReputationClientConfig(raw: Record<string, unknown>): ParsedReputationConfig {
  const rosterRaw = raw["reputationRoster"];
  const rosterSchema = z.array(CaptureLegRequestSchema);
  const rosterParsed = rosterSchema.safeParse(rosterRaw ?? []);
  const captureLegs = rosterParsed.success ? rosterParsed.data : [];
  const rosterConfigError =
    rosterRaw !== undefined && !rosterParsed.success ? `client's reputationRoster failed to parse: ${rosterParsed.error.message}` : undefined;

  const locksRaw = (raw["reputationLocks"] ?? {}) as Record<string, unknown>;
  const locks: ClientLocks = {
    neverSay: safeField(z.array(z.string()), locksRaw["neverSay"], []),
    requiredFramingAnyOf: safeField(z.array(z.string()), locksRaw["requiredFramingAnyOf"], []),
  };

  const autonomy = safeField(z.string(), raw["reputationAutonomy"], "approve-all");
  const baselineRatingAvg = safeField(z.record(z.string(), z.number()), raw["reputationBaselineRatingAvg"], {});
  const triageConfigParsed = TriageConfigSchema.safeParse(raw["reputationTriageConfig"]);
  const steer = safeField(z.record(z.string(), z.unknown()), raw["reputationSteer"], {});
  const pulseNumberParsed = z.number().int().positive().safeParse(raw["reputationPulseNumber"]);

  return {
    captureLegs,
    ...(rosterConfigError !== undefined ? { rosterConfigError } : {}),
    locks,
    autonomy,
    baselineRatingAvg,
    ...(triageConfigParsed.success ? { triageConfigOverride: triageConfigParsed.data as TriageConfig } : {}),
    steer,
    ...(pulseNumberParsed.success ? { pulseNumber: pulseNumberParsed.data } : {}),
  };
}
