import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createLandingBuilderAgentWorkflow } from "../src/workflow/create-landing-builder-agent-workflow.js";
import { setupTestEnvironment, smartFakeRouter, makePromptStore, goodCopy, goodCompose, goodCraftVerdict, REAL_FORGE_FIXTURE_SITE, type TestEnvironment } from "./test-helpers.js";

/** Parses a real component file's own prop destructuring (`export function Hero({ hero }: { hero: HeroContent })`) so a test can assert the generator uses the SAME prop name, instead of hand-copying the expectation and risking it drifting from the real kit. */
async function declaredPropName(componentFile: string): Promise<string> {
  const source = await fs.readFile(path.join(REAL_FORGE_FIXTURE_SITE, "src", "components", componentFile), "utf8");
  const match = /export function \w+\(\{\s*(\w+)/.exec(source);
  if (!match) throw new Error(`could not find a destructured prop in ${componentFile}`);
  return match[1]!;
}

/**
 * A dependency-free structural syntax check: every `(`/`[`/`{` in `source`
 * must close, in order, with its matching `)`/`]`/`}`, correctly skipping
 * over string/template-literal contents (including `${...}` interpolation,
 * which re-enters code and needs its own brace counting) and comments so a
 * bracket character inside a string is never mistaken for real syntax. This
 * doesn't replace a real parser (it can't catch every possible syntax
 * error), but it reliably catches the failure mode string-templated code
 * generation is actually prone to: a bad interpolation leaving mismatched
 * braces — exactly the class of bug this generator's own template literals
 * could introduce.
 */
function assertBalancedSyntax(source: string, fileName: string): void {
  const stack: string[] = [];
  const closerFor: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const n = source.length;
  let i = 0;

  function skipString(quote: string): void {
    i++;
    while (i < n && source[i] !== quote) {
      if (source[i] === "\\") i++;
      i++;
    }
    i++;
  }

  function skipTemplateLiteral(): void {
    i++; // opening `
    while (i < n) {
      if (source[i] === "\\") {
        i += 2;
        continue;
      }
      if (source[i] === "`") {
        i++;
        return;
      }
      if (source[i] === "$" && source[i + 1] === "{") {
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          if (source[i] === "{") depth++;
          else if (source[i] === "}") depth--;
          else if (source[i] === "`") {
            skipTemplateLiteral();
            continue;
          } else if (source[i] === '"') {
            skipString('"');
            continue;
          } else if (source[i] === "'") {
            skipString("'");
            continue;
          }
          i++;
        }
        continue;
      }
      i++;
    }
  }

  while (i < n) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"') {
      skipString('"');
      continue;
    }
    if (c === "'") {
      skipString("'");
      continue;
    }
    if (c === "`") {
      skipTemplateLiteral();
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      stack.push(c);
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      if (top !== closerFor[c]) {
        throw new Error(`${fileName}: unbalanced "${c}" at offset ${i} (expected to close "${top ?? "<nothing open>"}"))`);
      }
      i++;
      continue;
    }
    i++;
  }

  if (stack.length > 0) {
    throw new Error(`${fileName}: ${stack.length} unclosed bracket(s) — first unclosed is "${stack[0]}"`);
  }
}

describe("landing-builder-agent workflow: MODE=build happy path", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment("forge");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  const baseParams = { clientSlug: "forge", productId: "s6", runKind: "setup" as const };

  it("pauses at the mandatory human review gate, then completes as status:ok once approved", async () => {
    const runId = "run_forge_build_1";
    const workflowFn = createLandingBuilderAgentWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: smartFakeRouter([goodCopy(), goodCompose(), goodCraftVerdict()]),
    });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());

    const first = await engine.run(workflowFn, { ...baseParams, runId });
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");
    expect(first.pendingGateId).toContain("08-human-review");

    await engine.resolveGate(runId, "08-human-review", { decision: "approve", actor: "jane@karoslabs.com", at: new Date().toISOString() });

    const second = await engine.run(workflowFn, { ...baseParams, runId });
    expect(second.status).toBe("completed");
    if (second.status !== "completed") throw new Error("unreachable");
    expect(second.output.status).toBe("ok");
    expect(second.output.gate).toBe("pass");
    expect(second.output.client).toBe("forge");
    expect(second.output.assumptions.some((a) => a.includes("render check skipped"))).toBe(true);

    const siteRoot = path.join(env.landingConfig.engineClientsRoot, "forge", "site");
    const globalsCss = await fs.readFile(path.join(siteRoot, "src", "app", "globals.css"), "utf8");
    expect(globalsCss).toContain("#FF4D00");
    expect(globalsCss.trim().startsWith('@import "tailwindcss";')).toBe(true);

    const contentSource = await fs.readFile(path.join(siteRoot, "src", "content", "generated.ts"), "utf8");
    expect(contentSource).toContain('import type { LandingContent } from "@/lib/content-schema";');
    assertBalancedSyntax(contentSource, "generated.ts");
    const contentMatch = /=\s*(\{[\s\S]*\});/.exec(contentSource);
    const content = JSON.parse(contentMatch![1]!);
    expect(content.hero.headline).toContain("athlete");

    // Cross-checked against the real components' own declared prop names — not a hand-copied
    // expectation that could silently drift from the real kit (the exact P0 the Deep Parity Audit
    // found: every component was passed a uniform `data` prop regardless of what it actually
    // declares).
    const pageTsx = await fs.readFile(path.join(siteRoot, "src", "app", "page.tsx"), "utf8");
    assertBalancedSyntax(pageTsx, "page.tsx");
    for (const [componentFile, componentTag] of [
      ["hero.tsx", "Hero"],
      ["site-nav.tsx", "SiteNav"],
      ["site-footer.tsx", "SiteFooter"],
    ] as const) {
      const prop = await declaredPropName(componentFile);
      expect(pageTsx).toContain(`<${componentTag} ${prop}={content.`);
    }

    // layout.tsx was patched with this client's real title/description, not left as the
    // template's own placeholder metadata.
    const layoutTsx = await fs.readFile(path.join(siteRoot, "src", "app", "layout.tsx"), "utf8");
    expect(layoutTsx).toContain("FORGE · Train like an athlete, not a tourist");
    expect(layoutTsx).toContain("An adaptive strength program built around you.");
    expect(layoutTsx).toContain('lang="en-US"');
  });

  it("resolves to held when the human reviewer rejects", async () => {
    const runId = "run_forge_build_reject";
    const workflowFn = createLandingBuilderAgentWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: smartFakeRouter([goodCopy(), goodCompose(), goodCraftVerdict()]),
    });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());

    await engine.run(workflowFn, { ...baseParams, runId });
    await engine.resolveGate(runId, "08-human-review", { decision: "reject", actor: "jane@karoslabs.com", reason: "hero copy is off-brand", at: new Date().toISOString() });
    const second = await engine.run(workflowFn, { ...baseParams, runId });
    expect(second.status).toBe("held");
  });

  it("autoApprove:true skips the human gate and completes in one run", async () => {
    const runId = "run_forge_build_autoapprove";
    const workflowFn = createLandingBuilderAgentWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: smartFakeRouter([goodCopy(), goodCompose(), goodCraftVerdict()]),
      autoApprove: true,
    });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const result = await engine.run(workflowFn, { ...baseParams, runId });
    expect(result.status).toBe("completed");
  });

  it("resolves to needs_human when the craft verdict fails", async () => {
    const runId = "run_forge_build_craft_fail";
    const workflowFn = createLandingBuilderAgentWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: smartFakeRouter([goodCopy(), goodCompose(), { verdict: "content_fail", evidence: ["no signature moment"], reason: "the page has no real signature moment", toolVersion: "1.0.0" }]),
      autoApprove: true,
    });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const result = await engine.run(workflowFn, { ...baseParams, runId });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.status).toBe("needs_human");
  });

  it("blocks intake when the client has no brand.json/intake.md bundle yet", async () => {
    const runId = "run_no_bundle";
    const workflowFn = createLandingBuilderAgentWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: smartFakeRouter([goodCopy(), goodCompose(), goodCraftVerdict()]),
    });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const result = await engine.run(workflowFn, { clientSlug: "nobody", productId: "s6", runKind: "setup", runId });
    expect(result.status).toBe("blocked_intake");
  });
});
