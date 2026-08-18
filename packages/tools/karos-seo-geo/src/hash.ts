import { createHash } from "node:crypto";
import { REPRODUCIBILITY } from "./scoring-config.js";

const UNIT_SEPARATOR = String.fromCharCode(0x1f);

/** The 12 `hash_inputs` fields, in the config's fixed order (`reproducibility.hash_inputs`). */
export type HashInputs = Record<(typeof REPRODUCIBILITY.hash_inputs)[number], string>;

/**
 * `reproducibility.inputs_digest`: SHA-256 over all 12 `hash_inputs` fields,
 * each UTF-8 encoded, concatenated in the fixed config order, joined by the
 * 0x1F unit-separator byte. No sibling-column carve-out — every field is
 * inside the digest. Identical `inputs_digest` across two runs must produce
 * bit-identical integer scores ("nothing drifts silently").
 */
export function computeInputsDigest(inputs: HashInputs): string {
  const orderedValues = REPRODUCIBILITY.hash_inputs.map((field) => inputs[field] ?? "");
  const joined = orderedValues.join(UNIT_SEPARATOR);
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

export interface DriftEvent {
  driftId: string;
  clientId: string;
  prevRunId: string;
  newRunId: string;
  changedFields: string[];
  loggedAt: number;
}

/** Diffs two hash-input snapshots field-by-field — the only permitted way a score is allowed to change (`reproducibility.rule`). */
export function diffHashInputs(prev: HashInputs, next: HashInputs): string[] {
  return REPRODUCIBILITY.hash_inputs.filter((field) => prev[field] !== next[field]);
}
