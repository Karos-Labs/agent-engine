import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setupTestEnvironment } from "./test-helpers.js";
import type { RunJobRequest } from "../src/run-job.js";

/**
 * ── C3'S FIRST MANDATORY FIX (SCRUM-211). ──
 *
 * `POST /api/v1/runs/start` destructured `{ clientSlug, productId, runKind }`
 * out of a body it had just validated in full, and handed only those three to
 * the queue. `input` and `stageModels` were parsed and thrown away.
 *
 * The Pub/Sub push route and the pull consumer read the SAME schema and pass
 * everything through, so the same payload produced two different runs
 * depending on how it arrived: the queued one drafted the brief it was given,
 * the HTTP one drafted whatever it liked. Neither failed. That is why it
 * survived — a dropped brief is wrong output, not an error.
 *
 * These cases assert on what reaches the QUEUE rather than on what the agent
 * eventually writes, deliberately: the defect is entirely in the handoff, and
 * a test that ran a whole workflow to observe it would be slower and would
 * fail for a dozen unrelated reasons.
 */

/** Captures the request the route enqueues, and runs nothing. */
function captureEnqueue() {
  const seen: RunJobRequest[] = [];
  return {
    seen,
    enqueueRunJob: async (req: RunJobRequest) => {
      seen.push(req);
      return { runId: `queued-${seen.length}` };
    },
  };
}

async function start(body: Record<string, unknown>) {
  const env = await setupTestEnvironment();
  const capture = captureEnqueue();
  const app = createApp({
    durableStore: env.durableStore,
    runtimeDeps: env.runtimeDeps,
    enqueueRunJob: capture.enqueueRunJob,
  });
  const res = await request(app)
    .post("/api/v1/runs/start")
    .send({ clientSlug: "acme", productId: "x-agent", runKind: "recurring", ...body });
  await env.cleanup();
  return { res, enqueued: capture.seen[0] };
}

describe("runs/start hands the whole request to the queue", () => {
  it("passes the run's brief through instead of dropping it", async () => {
    const { res, enqueued } = await start({
      input: { audience: "heads of marketing", mustInclude: ["the month-two cliff"] },
    });
    expect(res.status).toBe(202);
    expect(enqueued!.input).toEqual({
      audience: "heads of marketing",
      mustInclude: ["the month-two cliff"],
    });
  });

  it("passes the per-stage model map through", async () => {
    // Separate from the brief on purpose (see `RunJobRequestSchema`): one is
    // what the run was asked to do, the other is how the agent is configured
    // to do it, and they belong to different people.
    const { enqueued } = await start({ stageModels: { "03-draft": "claude-sonnet-4-5" } });
    expect(enqueued!.stageModels).toEqual({ "03-draft": "claude-sonnet-4-5" });
  });

  it("OMITS input entirely when the run was asked for nothing", async () => {
    // `input: {}` and no `input` are different answers to `readRunBrief`:
    // "asked for nothing in particular" against "not asked at all". A
    // scheduled run is honestly the second, and sending an empty object would
    // make every one of them look like a brief that said nothing.
    const { enqueued } = await start({});
    expect(enqueued).not.toHaveProperty("input");
    expect(enqueued).not.toHaveProperty("stageModels");
  });

  it("reads the older `inputParams` spelling rather than silently dropping it", async () => {
    // Nothing sends this today. It is kept because zod strips unknown keys, so
    // deleting it would drop an old caller's brief in silence — the exact
    // defect this file exists to close, one field over.
    const { enqueued } = await start({ inputParams: { audience: "founders" } });
    expect(enqueued!.input).toEqual({ audience: "founders" });
  });

  it("lets `input` win when a caller sends both names", async () => {
    const { enqueued } = await start({
      inputParams: { audience: "the old name", tone: "dry" },
      input: { audience: "the new name" },
    });
    expect(enqueued!.input).toEqual({ audience: "the new name", tone: "dry" });
  });

  it("still refuses an unknown product before anything is enqueued", async () => {
    // The validation this route does synchronously is worth keeping: a client
    // error answered with 202 and a failure minutes later in a worker is a
    // strictly worse answer.
    const { res, enqueued } = await start({ productId: "carrier-pigeon-agent" });
    expect(res.status).toBe(400);
    expect(enqueued).toBeUndefined();
  });
});
