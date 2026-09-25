import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { InstagramCopyAgent } from "../src/agent/instagram-copy-agent.js";

/**
 * 2026-09-25: Geektime's Hebrew drafts ran past the 600 s step timeout on all
 * three attempts of both prep runs (pubsub-21793069060814783,
 * pubsub-21793655015127109) and the runs held with no draft. Copy turns
 * spend 84-88% of their output on `thought`; an attempt after a timeout
 * drafts without it. `omitThought` itself is covered in core
 * (`output-ceiling.test.ts`).
 */
const runtime = { router: {} as never, tools: {}, promptStore: {} as never };
const configOf = (agent: InstagramCopyAgent) => (agent as unknown as { config: { omitThought?: boolean; maxTokens?: number; id: string } }).config;

describe("the copy drafter after a timeout", () => {
  it("the drafter is lean by default (2026-09-25), and the planning prose can still be turned back on", () => {
    const normal = configOf(new InstagramCopyAgent(runtime));
    const planning = configOf(new InstagramCopyAgent(runtime, { omitThought: false }));
    expect(normal.omitThought).toBe(true);
    expect(planning.omitThought).toBe(false);
    expect({ ...planning, omitThought: undefined }).toEqual({ ...normal, omitThought: undefined });
  });

  it("the workflow picks the lean twin only after a timed-out attempt, off the checkpointed result", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/workflow/create-instagram-agent-workflow.ts"), "utf8");
    expect(src).toContain("new InstagramCopyAgent({ router: options.router, tools, promptStore: options.promptStore }, { omitThought: true })");
    expect(src).toContain("lastCopyAttemptTimedOut ? copyLeanAgent : copyAgent");
    // Sticky: once a run has timed out, every later attempt stays lean.
    expect(src).toMatch(/lastCopyAttemptTimedOut \|\|= revisedDraft === undefined && copyExec\.status !== "completed" && typeof \(copyExec as \{ timedOutAfterMs\?: unknown \}\)\.timedOutAfterMs === "number";/u);
  });
});
