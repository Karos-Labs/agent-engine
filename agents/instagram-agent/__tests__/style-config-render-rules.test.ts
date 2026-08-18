import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { StyleConfigSchema, type StyleConfig } from "../src/workflow/types.js";
import { fakeRouterSequence, finalTurn, goodBrandTokens, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "instagram_run_render_rules", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/**
 * P0 parity-audit Fix 2: a real legacy-shaped `02-style-config.json` is 100%
 * `check: "render"` rules (every one of `assets/style-config-template.json`'s
 * 5 worked examples in carousel-agent-v2), copied verbatim here as this
 * test's fixture. Before this fix, `StyleRuleSchema.check` was hardcoded
 * `z.literal("copy")`, so this exact shape failed to parse and HALTed intake
 * at step 02 every time.
 */
const LEGACY_SHAPED_STYLE_CONFIG: StyleConfig = {
  style_config_version: 1,
  canvas: { w: 1080, h: 1440, scale: 2, slides_min: 6, slides_max: 8 },
  rules: [
    { id: "figures-are-designed", check: "render", description: "Any number, score or comparison is rendered as a designed device, never as prose." },
    { id: "nothing-overlaps", check: "render", description: "No element overlaps another on any slide, checked on the rendered pixels." },
    { id: "no-empty-closer", check: "render", description: "The closing slide carries a photo or a device; a near-empty slide is a defect." },
    { id: "mono-face-sparingly", check: "render", description: "The mono or label face appears in few places; metadata belongs to the text faces." },
    { id: "real-photo-person-chips", check: "render", description: "A person chip uses a real verified photo of that person or the slide does not run." },
  ],
  banned_words: [],
  banned_chars: ["—", "–"],
  compliance: { regulated: false, required_framing: [], never_say: [] },
};

describe("02-freeze-style-config: a real legacy-shaped (100% check:'render') style config parses successfully (P0 parity-audit Fix 2)", () => {
  let env: TestEnvironment | undefined;

  afterEach(async () => {
    await env?.cleanup();
  });

  it("passes StyleConfigSchema.safeParse directly", () => {
    const result = StyleConfigSchema.safeParse(LEGACY_SHAPED_STYLE_CONFIG);
    expect(result.success).toBe(true);
  });

  it("clears step 02 intake and proceeds past it (never blocked_intake), through the real workflow", async () => {
    env = await setupTestEnvironment({ withConfig: false });
    await env.store.writeJson("acme", ["client", "config"], {
      instagramStyleConfig: LEGACY_SHAPED_STYLE_CONFIG,
      instagramBrandTokens: goodBrandTokens(),
    });

    const promptStore = makePromptStore();
    // Nothing past step 02 matters for this test -- fail fast right after
    // topic claim so we don't need a full research/copy/vetting router setup.
    const router = fakeRouterSequence([finalTurn({ text: "unused — this test only exercises step 02" })]);
    const workflowFn = createInstagramAgentWorkflow({ tools: env.tools, promptStore, router, repoRoot: env.repoRoot });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    // Whatever happens later (this run has no seeded facts for step 04+), it
    // must NOT be blocked_intake -- step 02 itself cleared this config.
    expect(result.status).not.toBe("blocked_intake");

    const stepRecords = await durableStore.listSteps(params.runId);
    const step02 = stepRecords.find((s) => s.stepId === "02-freeze-style-config");
    expect(step02?.status).toBe("completed");
  });
});
