import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { biTable, __resetBigQueryClient } from "../src/bigquery-client.js";

/**
 * Which project the BI rows land in.
 *
 * Prep's Firestore lives in the production project, so prep sets
 * GOOGLE_CLOUD_PROJECT=karoscmo to reach it. BigQuery inherited that and every
 * prep run tried to write production's table, was denied, and swallowed the
 * error — visible only as a WARNING on each run, with no prep telemetry ever
 * recorded. BQ_PROJECT_ID separates "where is Firestore" from "where does
 * telemetry go".
 */
const captured: { projectId?: string }[] = [];

vi.mock("@google-cloud/bigquery", () => ({
  BigQuery: class {
    constructor(opts: { projectId: string }) {
      captured.push(opts);
    }
    dataset(id: string) {
      return { table: (t: string) => ({ id: t, datasetId: id }) };
    }
  },
}));

const ORIGINAL = { ...process.env };

beforeEach(() => {
  captured.length = 0;
  __resetBigQueryClient();
  delete process.env.BQ_PROJECT_ID;
  delete process.env.BQ_DATASET_ID;
  delete process.env.GOOGLE_CLOUD_PROJECT;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("BigQuery target resolution", () => {
  it("prefers BQ_PROJECT_ID over GOOGLE_CLOUD_PROJECT", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "karoscmo"; // where prep's Firestore lives
    process.env.BQ_PROJECT_ID = "karoscmo-prep"; // where prep's telemetry belongs

    await biTable("agent_runs_bi");

    expect(captured[0]?.projectId).toBe("karoscmo-prep");
  });

  it("falls back to GOOGLE_CLOUD_PROJECT when BQ_PROJECT_ID is unset", async () => {
    // Production's shape: one project for both, and it must keep working
    // without adding a variable to the promote config.
    process.env.GOOGLE_CLOUD_PROJECT = "karoscmo";

    await biTable("agent_runs_bi");

    expect(captured[0]?.projectId).toBe("karoscmo");
  });

  it("treats an empty BQ_PROJECT_ID as unset rather than as a project named ''", async () => {
    // Cloud Build passes "" for an unset substitution, so this is the literal
    // value production would receive if the variable were ever wired there.
    process.env.GOOGLE_CLOUD_PROJECT = "karoscmo";
    process.env.BQ_PROJECT_ID = "";

    await biTable("agent_runs_bi");

    expect(captured[0]?.projectId).toBe("karoscmo");
  });

  it("no-ops when neither is set, instead of constructing a client", async () => {
    expect(await biTable("agent_runs_bi")).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("rebuilds the client when the target project changes", async () => {
    // The singleton pins projectId at construction; a cached client would keep
    // writing to the old project after a config change.
    process.env.BQ_PROJECT_ID = "karoscmo-prep";
    await biTable("agent_runs_bi");
    process.env.BQ_PROJECT_ID = "karoscmo";
    await biTable("agent_runs_bi");

    expect(captured.map((c) => c.projectId)).toEqual(["karoscmo-prep", "karoscmo"]);
  });

  it("reuses the client while the target is unchanged", async () => {
    process.env.BQ_PROJECT_ID = "karoscmo-prep";
    await biTable("agent_runs_bi");
    await biTable("credit_usage_bi");

    expect(captured).toHaveLength(1);
  });
});
