import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * AU49 (SCRUM-332): the inventory script's own regression test.
 *
 * The eleven names below are read INDIRECTLY — through `*FromEnv` factories,
 * through an env bag passed into a helper, or as a string argument that never
 * appears beside the word `env`. A naive grep reports every one of them as
 * "wired but never read", and deleting any one takes production down.
 *
 * So they are the test. If the script ever reports one of them as dead, the
 * script has lost a detection pattern — the config is fine.
 *
 * Lives in this package for the same reason the other repo-root guards do: it
 * is the one workspace whose suite already asserts on repo-level files.
 */
const KNOWN_FALSE_POSITIVES = [
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GCS_ARTIFACTS_BUCKET",
  "GCS_MEDIA_BUCKET",
  "GCS_WORKSPACE_BUCKET",
  "LANDING_ENGINE_ROOT",
  "LANDING_ENGINE_TEMPLATE_ROOT",
  "PROMPT_STORE_DRIVER",
  "PUBSUB_PROJECT_ID",
  "QUEUE_PROVIDER",
  "QUEUE_SUBSCRIPTION_RUN_JOBS",
] as const;

interface InventoryJson {
  readByCode: string[];
  wiredByService: Record<string, string[]>;
  documented: string[];
  deltas: { readButUndocumented: string[]; wiredButUnread: string[]; documentedButUnread: string[]; catalogueOrphans: string[] };
}

function runInventory(): InventoryJson {
  const out = execFileSync("npx", ["tsx", "scripts/config-inventory.ts", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out) as InventoryJson;
}

describe("AU49: configuration inventory", () => {
  const inventory = runInventory();

  it("does not report any of the eleven indirect reads as dead", () => {
    const wrongly = KNOWN_FALSE_POSITIVES.filter((name) => inventory.deltas.wiredButUnread.includes(name));
    expect(wrongly, `the script lost a read-detection pattern for: ${wrongly.join(", ")}`).toEqual([]);
  });

  it("sees all eleven as genuinely read", () => {
    // Stronger than the above: not merely absent from the dead list, but
    // positively detected. A script that stopped scanning entirely would pass
    // the first assertion and fail this one.
    for (const name of KNOWN_FALSE_POSITIVES) {
      expect(inventory.readByCode, `${name} must be detected as read`).toContain(name);
    }
  });

  it("distinguishes the deploy surfaces rather than merging them", () => {
    // deploy-http and deploy-worker are different services with different
    // variables; a file-level view hides that.
    const services = Object.keys(inventory.wiredByService);
    expect(services).toContain("prep/deploy-http");
    expect(services).toContain("prep/deploy-worker");
    expect(services).toContain("prod/deploy-http");
    expect(services).toContain("prod/deploy-worker");

    // The worker mounts no HTTP routes, so it legitimately lacks the push
    // audience the http service needs — proof the split is real, not cosmetic.
    expect(inventory.wiredByService["prep/deploy-http"]).toContain("PUBSUB_PUSH_AUDIENCE_URL");
    expect(inventory.wiredByService["prep/deploy-worker"]).not.toContain("PUBSUB_PUSH_AUDIENCE_URL");
  });

  it("finds every variable it claims to find, in a plausible quantity", () => {
    // A parsing failure (CRLF once did exactly this) reports zero and reads as
    // a clean bill of health, so assert the scan actually saw something.
    expect(inventory.readByCode.length).toBeGreaterThan(40);
    expect(inventory.documented.length).toBeGreaterThan(40);
    expect(Object.values(inventory.wiredByService).every((names) => names.length > 10)).toBe(true);
  });

  it("has no read-but-undocumented variables left", () => {
    expect(inventory.deltas.readButUndocumented).toEqual([]);
  });

  it("has no capability-catalogue rows pointing at variables nothing reads", () => {
    // Keeps AU55's report honest: a row naming a dead variable would report a
    // capability as configurable when it is not.
    expect(inventory.deltas.catalogueOrphans).toEqual([]);
  });
});
