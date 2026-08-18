import { describe, expect, it } from "vitest";
import { computeInputsDigest, diffHashInputs, type HashInputs } from "../src/hash.js";
import { REPRODUCIBILITY } from "../src/scoring-config.js";

function fixtureInputs(overrides: Record<string, string> = {}): HashInputs {
  const base = Object.fromEntries(REPRODUCIBILITY.hash_inputs.map((field) => [field, `${field}-v1`]));
  return { ...base, ...overrides } as HashInputs;
}

describe("computeInputsDigest (seo-geo-scoring-config.json reproducibility.inputs_digest)", () => {
  it("is deterministic: identical hash_inputs produce the identical digest", () => {
    const a = computeInputsDigest(fixtureInputs());
    const b = computeInputsDigest(fixtureInputs());
    expect(a).toBe(b);
  });

  it("changing any single hashed field changes the digest — nothing drifts silently", () => {
    const base = computeInputsDigest(fixtureInputs());
    const changed = computeInputsDigest(fixtureInputs({ crawl_snapshot_hash: "different" }));
    expect(changed).not.toBe(base);
  });

  it("is a 64-char lowercase hex SHA-256 digest", () => {
    const digest = computeInputsDigest(fixtureInputs());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("covers all 12 hash_inputs fields, no sibling-column carve-out", () => {
    expect(REPRODUCIBILITY.hash_inputs.length).toBe(12);
  });
});

describe("diffHashInputs", () => {
  it("reports exactly the changed fields between two frozen snapshots", () => {
    const prev = fixtureInputs();
    const next = fixtureInputs({ crawl_snapshot_hash: "new", entity_snapshot_hash: "new2" });
    expect(diffHashInputs(prev, next).sort()).toEqual(["crawl_snapshot_hash", "entity_snapshot_hash"].sort());
  });

  it("reports no changes when nothing differs", () => {
    expect(diffHashInputs(fixtureInputs(), fixtureInputs())).toEqual([]);
  });
});
