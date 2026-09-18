import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentContext } from "@agent-engine/core";
import { InstagramPostPackagerAgent } from "../src/agent/instagram-post-packager-agent.js";
import {
  ALT_TEXT_MAX_CHARS,
  ALT_TEXT_WIRE_MAX_CHARS,
  FIRST_COMMENT_MAX_CHARS,
  PostPackageSchema,
  checkPackageRules,
  clampedAltSlides,
  truncateOnWordBoundary,
  type PackagedSlide,
} from "../src/workflow/post-package.js";
import { StudioDesignBriefOutputSchema, StudioTemplateDraftSchema } from "../src/workflow/template-studio.js";
import { fakeRouterSequence, finalTurn, makePromptStore } from "./test-helpers.js";

/**
 * Phase 5.5, item G2 — **a schema max on a model output is a coin flip that
 * loses the whole step.**
 *
 * What it cost, measured on 2026-09-16: `08c-package-post` returned an alt
 * text a few characters past `.max(125)` on two of three live runs. The
 * structured output failed validation, `finalOutput` was null, the workflow's
 * one re-ask is reachable only from the free-checks branch (which needs a
 * parsed package to get to), and both posts shipped with **no hashtags, no
 * alt text and no first comment at all**. The human gate approved them.
 *
 * The limit was never wrong — 125 is where Instagram truncates the field and
 * it is still guaranteed on everything that ships. What was wrong is that a
 * model had to hit it exactly, in Hebrew, counting characters. Now the wire
 * accepts 400 and code cuts at a word boundary.
 *
 * Note which instrument does the cutting: `.overwrite()` inside
 * `PostPackageSchema`, not a call the workflow makes. `z.toJSONSchema` throws
 * on a `.transform()` — which would have turned every packager call into a
 * `tooling_error`, a worse defect than the one being fixed — and it is blind
 * to `.overwrite()`, which still runs inside `parse`. So the clamp holds at
 * `parseStructuredOutput` AND at `BaseAgent.validateAndFinish`, and there is
 * no call site that can forget it. The first case below is what proves that.
 */

const ctx: AgentContext = { runId: "run_pkg_clamp", clientSlug: "karoslabs", productId: "instagram-agent", runKind: "recurring", metadata: {} };

/** 236 characters, near enough twice the limit: the shape of the answer that lost two runs their package. */
const ALT_240 =
  "A dark slide carrying a single white headline about response times, with a thin orange rule beneath it and the client's own logo disc in the upper corner, over a photograph of an empty open-plan office shot from the doorway in daylight.";

const SHIPPED: PackagedSlide[] = [
  { n: 1, headline: "Speed is the whole offer", sourceRef: "Teams that reply within five minutes convert seven times more often" },
  { n: 2, headline: "What five minutes is worth", sourceRef: "Teams that reply within five minutes convert seven times more often" },
];

function packagerOutput(alt: string): unknown {
  return {
    hashtags: ["aimarketing", "gtm", "demandgen"],
    altText: [
      { n: 1, alt },
      { n: 2, alt: "A pale slide with one line of type and a small bar chart under it." },
    ],
    firstCommentText: "The response-time figure comes from the vendor's own 2026 benchmark; the second is a trade survey from last year.",
  };
}

describe("an over-long alt text is cut, not refused", () => {
  it("THE PREMISE: this alt is past the limit, and the OLD wire schema rejects it", () => {
    expect(ALT_240.length).toBe(236);
    expect(ALT_240.length).toBeGreaterThan(ALT_TEXT_MAX_CHARS);
    // The schema as it stood on 2026-09-16, re-declared so the case cannot go
    // green because the fixture drifted under the limit.
    const oldWire = z.object({ alt: z.string().min(1).max(ALT_TEXT_MAX_CHARS) });
    expect(oldWire.safeParse({ alt: ALT_240 }).success).toBe(false);
    expect(ALT_240.length).toBeLessThan(ALT_TEXT_WIRE_MAX_CHARS);
  });

  it("the packager COMPLETES, and the alt ships at or under 125 characters, ending on a word", async () => {
    const router = fakeRouterSequence([finalTurn(packagerOutput(ALT_240))]);
    const result = await new InstagramPostPackagerAgent({ router, tools: {}, promptStore: makePromptStore() }).run(ctx, { channel: "instagram" });

    expect(result.status).toBe("completed");
    const pkg = result.finalOutput!;
    const first = pkg.altText[0]!.alt;
    expect(first.length).toBeLessThanOrEqual(ALT_TEXT_MAX_CHARS);
    // A word boundary: the kept text is a prefix of the original ending at a
    // space, plus the ellipsis that marks the cut.
    expect(first.endsWith("…")).toBe(true);
    const kept = first.slice(0, -1);
    expect(ALT_240.startsWith(kept)).toBe(true);
    expect(ALT_240[kept.length]).toBe(" ");

    // Hashtags are never the casualty of an alt text again.
    expect(pkg.hashtags).toHaveLength(3);
    expect(pkg.altText).toHaveLength(2);
    expect(pkg.firstCommentText.length).toBeGreaterThan(0);
  });

  it("the clamp is recorded, per slide, for the gate payload", async () => {
    const pkg = PostPackageSchema.parse(packagerOutput(ALT_240));
    expect(clampedAltSlides(pkg)).toEqual([1]);
    // An alt that was always inside the limit is not reported as clamped.
    expect(clampedAltSlides(PostPackageSchema.parse(packagerOutput("A dark slide, one white line, a thin orange rule.")))).toEqual([]);
  });

  it("the clamped package passes the free checks it used to fail", () => {
    const pkg = PostPackageSchema.parse(packagerOutput(ALT_240));
    const verdict = checkPackageRules({ pkg, slides: SHIPPED, coreTerms: ["ai marketing", "gtm"] });
    expect(verdict.ok, verdict.ok ? "" : verdict.reason).toBe(true);
  });

  it(`a package built in CODE is still checked against ${ALT_TEXT_MAX_CHARS}, because nothing parsed it`, () => {
    // `native-corrections.ts` rebuilds `altText` entry by entry, so the
    // deterministic rule in `checkPackageRules` is not dead code.
    const pkg = { ...PostPackageSchema.parse(packagerOutput("fine")), altText: [{ n: 1, alt: ALT_240 }, { n: 2, alt: "ok, a second plate" }] };
    const verdict = checkPackageRules({ pkg, slides: SHIPPED, coreTerms: ["ai marketing"] });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain(`past the ${ALT_TEXT_MAX_CHARS}-character cap`);
  });

  it("an answer past the WIRE maximum is still refused — the widening is headroom, not surrender", async () => {
    const router = fakeRouterSequence([finalTurn(packagerOutput("x".repeat(ALT_TEXT_WIRE_MAX_CHARS + 1)))]);
    const result = await new InstagramPostPackagerAgent({ router, tools: {}, promptStore: makePromptStore() }).run(ctx, { channel: "instagram" });
    // This is the status `08c` must treat as a re-ask trigger: on 2026-09-16
    // it fell through to "ship without the package" instead, because the
    // retry sat behind the free-checks branch.
    expect(result.status).toBe("content_fail");
    expect(result.finalOutput).toBeNull();
  });
});

describe("the first comment takes the same treatment, and hashtags deliberately do not", () => {
  it("a 900-character first comment is cut to 600 on a word boundary", () => {
    const long = `${"The response-time figure comes from the vendor's own benchmark. ".repeat(14)}And a last clause.`;
    expect(long.length).toBeGreaterThan(FIRST_COMMENT_MAX_CHARS);
    const pkg = PostPackageSchema.parse({ ...(packagerOutput("fine") as Record<string, unknown>), firstCommentText: long });
    expect(pkg.firstCommentText.length).toBeLessThanOrEqual(FIRST_COMMENT_MAX_CHARS);
    expect(pkg.firstCommentText.endsWith("…")).toBe(true);
  });

  it("an over-long hashtag is REFUSED, because a truncated tag is a different tag", () => {
    const parsed = PostPackageSchema.safeParse({ ...(packagerOutput("fine") as Record<string, unknown>), hashtags: ["a".repeat(41), "gtm", "demandgen"] });
    expect(parsed.success).toBe(false);
  });
});

describe("every clamped schema still converts to JSON Schema — the guard for the instrument itself", () => {
  it.each([
    ["instagram-post-package (08c)", PostPackageSchema],
    ["instagram-design-brief (00c3)", StudioDesignBriefOutputSchema],
    ["instagram-template-designer (00c4)", StudioTemplateDraftSchema],
  ])("%s", (_name, schema) => {
    // `toRootObjectJsonSchema` calls `z.toJSONSchema(turnSchema)` in the
    // DEFAULT (output) mode to put the schema on the wire, and zod 4 throws
    // `Transforms cannot be represented in JSON Schema` there. So a clamp
    // written with `.transform()` instead of `.overwrite()` would not clamp
    // anything: it would make every one of these steps a `tooling_error` on
    // every call. This is the exact envelope `BaseAgent.buildTurnSchema()`
    // builds.
    const turn = z.discriminatedUnion("type", [z.object({ type: z.literal("final"), thought: z.string().optional(), output: schema })]);
    expect(() => z.toJSONSchema(turn)).not.toThrow();
  });
});

describe("truncateOnWordBoundary", () => {
  it("leaves anything inside the limit exactly as it was", () => {
    expect(truncateOnWordBoundary("A short alt text.", 125)).toBe("A short alt text.");
  });

  it("never returns more characters than it was given room for, ellipsis included", () => {
    for (const max of [10, 24, 60, 125, 600]) {
      const out = truncateOnWordBoundary("word ".repeat(400), max);
      expect(out.length).toBeLessThanOrEqual(max);
    }
  });

  it("falls back to a hard cut for a script with no spaces, rather than returning almost nothing", () => {
    // Chinese and Japanese have no word boundary to find. A rule that looked
    // for one and gave up would return an empty alt for those clients.
    const cjk = "的".repeat(200);
    const out = truncateOnWordBoundary(cjk, 40);
    expect(out.length).toBe(40);
    expect(out.endsWith("…")).toBe(true);
  });

  it("cuts a Hebrew sentence at a space, like any other space-separated script", () => {
    const hebrew = "שקף כהה ובו כותרת לבנה אחת על רקע צילום של משרד ריק שצולם מן הפתח באור יום, ולצידה עמודה כתומה דקה מאוד";
    const out = truncateOnWordBoundary(hebrew, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
    expect(hebrew.startsWith(out.slice(0, -1))).toBe(true);
  });
});
