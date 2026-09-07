import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { AgentToolRegistry } from "@agent-engine/core";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import type { SeoGeoReport } from "../src/workflow/types.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, withMeasuredCapture, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "seo_geo_prompt_agent", clientSlug: "acme", productId: "seo-geo-agent", runKind: "setup" as const };

/** What `SeoGeoPromptSetAgent` returns for an Israeli, Hebrew-first client: buyer questions in Hebrew, brand and navigational ones naming the brand, a native-script alias and a real roster. */
function goodPromptSet() {
  // Six genuinely different questions per intent: the workflow dedupes near-identical text (5-shingle Jaccard), so a
  // fixture that only varied a counter would collapse to one prompt per intent and prove nothing.
  const byIntent: Record<"discovery" | "comparison" | "problem" | "brand" | "navigational", string[]> = {
    discovery: [
      "איפה כדאי לקרוא חדשות טכנולוגיה בעברית?",
      "מהם אתרי החדשות המובילים על סטארטאפים בישראל?",
      "איזה אתר מסקר גיוסי הון של חברות ישראליות באופן הכי מהיר?",
      "מי מפרסם את הכיסוי הטוב ביותר על ההייטק הישראלי?",
      "Which sites cover the Israeli startup scene in depth?",
      "Where do Israeli developers get their daily tech news?",
    ],
    comparison: [
      "מה ההבדל בין Rivalco לאתרי חדשות טכנולוגיה אחרים בישראל?",
      "האם עדיף לעקוב אחרי מדור ההייטק של עיתון כלכלי או אחרי אתר ייעודי?",
      "איך משווים בין אתרי חדשות טכנולוגיה מבחינת אמינות?",
      "Is a dedicated tech site better than a newspaper's tech desk for Israeli startup news?",
      "How do the Israeli tech news outlets differ in what they cover?",
      "מי מסקר יותר לעומק: אתרי חדשות כלליים או אתרי טכנולוגיה?",
    ],
    problem: [
      "אני רוצה להתעדכן בגיוסים של סטארטאפים ישראליים בלי לפספס — מה הדרך הטובה ביותר?",
      "איך אפשר לדעת אילו חברות הייטק מגייסות עובדים עכשיו בישראל?",
      "מאיפה משיגים ניתוח מעמיק של אקזיטים בהייטק הישראלי?",
      "I want a Hebrew source that explains tech news for non-engineers — what should I read?",
      "How can a founder get their funding round covered by the Israeli tech press?",
      "מה עושים כדי שכתבה על הסטארטאפ שלי תתפרסם באתר טכנולוגיה?",
    ],
    brand: [
      "מה זה Acme Corp ומה האתר הזה מסקר?",
      "האם Acme Corp הוא מקור אמין לחדשות טכנולוגיה?",
      "מה אומרים קוראים על Acme Corp?",
      "What is Acme Corp and who reads it?",
      "How does Acme Corp compare to other Israeli tech news sites?",
      "מי עומד מאחורי Acme Corp ומתי הוא נוסד?",
    ],
    navigational: [
      "מה כתובת האתר הרשמי של Acme Corp?",
      "איך יוצרים קשר עם המערכת של Acme Corp?",
      "האם ל-Acme Corp יש ניוזלטר או ערוץ טלגרם?",
      "Where is the Acme Corp jobs board?",
      "Does Acme Corp publish an events calendar?",
      "איפה מוצאים את מדור הגיוסים של Acme Corp?",
    ],
  };
  const prompts = (Object.keys(byIntent) as Array<keyof typeof byIntent>).flatMap((intentType) => byIntent[intentType].map((promptText) => ({ intentType, promptText })));
  return {
    language: "he",
    marketSummary: "Hebrew-speaking Israeli tech readers who ask assistants in Hebrew, with a smaller English-speaking share.",
    brandAliases: ["אקמי", "Acme Corp"],
    competitors: [{ name: "Rivalco", website: "https://rivalco.example" }, { name: "Newcomer Ltd" }, { name: "acme corp" }],
    prompts,
  };
}

async function readReport(env: TestEnvironment, runId: string): Promise<SeoGeoReport> {
  const record = await env.store.readJson<{ deliverable: SeoGeoReport }>("acme", ["ledger", "deliverables", runId, "_", "seo-geo-report"]);
  if (!record) throw new Error("no deliverable persisted");
  return record.deliverable;
}

describe("promptDrafter: \"agent\" — the prompt set drafted in the buyer's language and market (RFC-04 §2 Phase 1)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment({ withCompetitors: false });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("freezes the agent's prompts, aliases and roster, passes the aliases to every capture, and says so on the report", async () => {
    const router = smartFakeRouter([goodPromptSet(), goodFixDrafts(), goodNarrative()]);
    const captureInputs: unknown[] = [];
    const measured = withMeasuredCapture(env.tools);
    const spiedCapture = measured["research.captureVisibility"]!;
    const tools: AgentToolRegistry = {
      ...measured,
      "research.captureVisibility": {
        ...spiedCapture,
        execute: vi.fn(async (input: unknown, opts: unknown) => {
          captureInputs.push(input);
          return spiedCapture.execute(input as never, opts as never);
        }),
      } as AgentToolRegistry[string],
    };
    const workflowFn = createSeoGeoAgentWorkflow({ tools, promptStore: makePromptStore(), router, autoApprove: true, promptDrafter: "agent" });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, params);
    expect(result.status).toBe("completed");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("02a-draft-prompt-set-agent");
    expect(stepIds).toContain("02b-finalize-prompt-set");

    const report = await readReport(env, params.runId);
    expect(report.promptSet.drafter).toBe("agent");
    expect(report.promptSet.language).toBe("he");
    expect(report.promptSet.prompts).toHaveLength(25);
    for (const intent of ["discovery", "comparison", "problem", "brand", "navigational"]) {
      expect(report.promptSet.prompts.filter((p) => p.intentType === intent)).toHaveLength(5);
    }
    // The primary name is never its own alias; the native-script spelling is kept.
    expect(report.promptSet.brandAliases).toEqual(["אקמי"]);
    // No curated roster on this client, so the agent's real competitors become the locked roster — minus the client itself.
    expect(report.promptSet.competitorRoster).toEqual(["Rivalco", "Newcomer Ltd"]);
    expect(report.promptSet.marketSummary).toContain("Hebrew");
    expect(report.promptSet.drafterFallbackReason).toBeUndefined();

    // Every capture cell was asked to recognise the alias too.
    expect(captureInputs.length).toBeGreaterThan(0);
    for (const input of captureInputs) expect((input as { clientBrandAliases?: string[] }).clientBrandAliases).toEqual(["אקמי"]);

    const beliefs = await env.store.readJson<{ seoGeoFrozenPromptSet: { drafter: string; brandAliases: string[]; language: string } }>("acme", ["memory", "beliefs"]);
    expect(beliefs?.seoGeoFrozenPromptSet).toMatchObject({ drafter: "agent", brandAliases: ["אקמי"], language: "he" });
  });

  it("keeps the template set, and says why, when the agent's draft does not cover every intent type", async () => {
    const partial = { ...goodPromptSet(), prompts: Array.from({ length: 16 }, (_, i) => ({ intentType: "discovery" as const, promptText: `שאלה כללית מספר ${i} על חדשות טכנולוגיה בישראל` })) };
    const router = smartFakeRouter([partial, goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore: makePromptStore(), router, autoApprove: true, promptDrafter: "agent" });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, params);
    expect(result.status).toBe("completed");
    const report = await readReport(env, params.runId);
    expect(report.promptSet.drafter).toBe("templates");
    expect(report.promptSet.drafterFallbackReason).toContain("covered 1 of 5 intent types");
    expect(report.promptSet.language).toBe("en");
    expect(report.promptSet.brandAliases).toEqual([]);
  });

  it("never redrafts a reused frozen set, so a recurring run costs no drafting turn", async () => {
    const router = smartFakeRouter([goodPromptSet(), goodFixDrafts(), goodNarrative()]);
    const complete = vi.spyOn(router, "complete");
    const tools = withMeasuredCapture(env.tools);
    const promptStore = makePromptStore();
    const first = await new WorkflowEngine(new MemoryDurableStepStore()).run(createSeoGeoAgentWorkflow({ tools, promptStore, router, autoApprove: true, promptDrafter: "agent" }), params);
    expect(first.status).toBe("completed");
    const draftingTurnsFirst = complete.mock.calls.length;

    const recurring = { ...params, runId: "seo_geo_prompt_agent_2", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();
    const second = await new WorkflowEngine(durableStore).run(createSeoGeoAgentWorkflow({ tools, promptStore, router, autoApprove: true, promptDrafter: "agent" }), recurring);
    expect(second.status).toBe("completed");
    const stepIds = (await durableStore.listSteps(recurring.runId)).map((s) => s.stepId);
    expect(stepIds).not.toContain("02a-draft-prompt-set-agent");
    // Fix drafts + narrative only: one fewer model turn than the run that drafted the set.
    expect(complete.mock.calls.length - draftingTurnsFirst).toBe(draftingTurnsFirst - 1);
    const report = await readReport(env, recurring.runId);
    expect(report.promptSet.source).toBe("reused");
    expect(report.promptSet.drafter).toBe("agent");
    expect(report.promptSet.brandAliases).toEqual(["אקמי"]);
  });
});
