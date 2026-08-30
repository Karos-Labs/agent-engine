import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_READ_METHODS_ALLOWLIST,
  CONNECTOR_KEYS,
  CRUX_DERIVED_ALLOWLIST,
  READ_METHODS_ALLOWLIST,
  ReadMethodNotAllowedError,
  assertReadMethodAllowed,
  isReadMethodAllowed,
} from "../src/allowlist.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONNECTORS_CONFIG_PATH = path.resolve(HERE, "..", "..", "karos-seo-geo", "src", "config", "connectors-config.data.ts");

/**
 * `allowlist.ts` mirrors `connectors-config.data.ts` rather than importing it
 * (that file is not part of `karos-seo-geo`'s public API, and `karos-seo-geo`
 * is deliberately network-free — see that file's own doc comment). A mirror
 * that nothing checks is a mirror that drifts, so this reads the config off
 * disk and pins the two together.
 */
interface ConnectorEntry {
  key: string;
  api?: string;
  read_methods_allowlist?: string[];
}

function loadConnectorsConfig(): { connectors: ConnectorEntry[] } {
  const source = readFileSync(CONNECTORS_CONFIG_PATH, "utf8");
  const start = source.indexOf("{", source.indexOf("export const connectorsConfigData"));
  const end = source.lastIndexOf("}");
  return JSON.parse(source.slice(start, end + 1)) as { connectors: ConnectorEntry[] };
}

describe("the enforced READ-method allowlist", () => {
  const config = loadConnectorsConfig();
  const byKey = new Map(config.connectors.map((connector) => [connector.key, connector]));

  it("mirrors connectors-config.data.ts's read_methods_allowlist exactly, connector by connector", () => {
    for (const key of ["gsc", "ga4", "gbp"] as const) {
      expect(byKey.get(key)?.read_methods_allowlist, `${key} lost its read_methods_allowlist in the config`).toBeDefined();
      expect(CONFIG_READ_METHODS_ALLOWLIST[key]).toEqual(byKey.get(key)?.read_methods_allowlist);
    }
  });

  it("pins the config gap this ticket reports: crux carries NO read_methods_allowlist at all", () => {
    // Not a bug in this package — a defect in the config, recorded here so it
    // is a failing test the day someone adds the array (at which point
    // CRUX_DERIVED_ALLOWLIST should become a transcription and this test
    // should be updated to assert equality, not absence).
    expect(byKey.get("crux")).toBeDefined();
    expect(byKey.get("crux")?.read_methods_allowlist).toBeUndefined();
    // The derivation's only source: the crux entry's own `api` string names both methods.
    for (const method of CRUX_DERIVED_ALLOWLIST) {
      expect(byKey.get("crux")?.api ?? "").toContain(method);
    }
  });

  it("covers all four connectors and nothing else", () => {
    expect(Object.keys(READ_METHODS_ALLOWLIST).sort()).toEqual([...CONNECTOR_KEYS].sort());
    expect(config.connectors.map((connector) => connector.key).sort()).toEqual([...CONNECTOR_KEYS].sort());
  });

  it("makes GBP's write endpoints physically uncallable — the FLAG-1 guard, on the one write-capable scope", () => {
    // business.manage is write-capable and there is no read-only GBP scope, so
    // this table is the only thing between a bug and a posted review reply.
    for (const write of [
      "mybusiness.accounts.locations.reviews.reply",
      "mybusinessbusinessinformation.locations.patch",
      "mybusinessbusinessinformation.locations.delete",
      "mybusiness.accounts.locations.localPosts.create",
      "mybusinessbusinessinformation.accounts.locations.reviews.list",
    ]) {
      expect(isReadMethodAllowed("gbp", write)).toBe(false);
      expect(() => assertReadMethodAllowed("gbp", write)).toThrow(ReadMethodNotAllowedError);
    }
  });

  it("does not let one connector borrow another's methods", () => {
    expect(isReadMethodAllowed("gsc", "properties.runReport")).toBe(false);
    expect(isReadMethodAllowed("ga4", "searchanalytics.query")).toBe(false);
    expect(isReadMethodAllowed("crux", "mybusinessbusinessinformation.locations.get")).toBe(false);
  });

  it("names what is permitted in the refusal, so the fix is obviously a config change", () => {
    try {
      assertReadMethodAllowed("gbp", "mybusiness.accounts.locations.reviews.reply");
      expect.unreachable("assertReadMethodAllowed should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ReadMethodNotAllowedError);
      expect((err as Error).message).toContain("businessprofileperformance.locations.getDailyMetricsTimeSeries");
      expect((err as Error).message).toContain("connectors-config.data.ts");
    }
  });
});
