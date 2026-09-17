import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { InstagramCustomArchetypeAgent, CUSTOM_ARCHETYPE_MAX_TOKENS } from "../src/agent/instagram-custom-archetype-agent.js";
import {
  CustomArchetypeMarkupSchema,
  MAX_CUSTOM_ARCHETYPE_SLOTS,
  SlideCustomArchetypeBriefSchema,
  SlideCustomArchetypeSchema,
  composeCustomArchetype,
} from "../src/workflow/types.js";
import { assertSafeMarkup } from "@agent-engine/tool-karos-templates";
import { validateCustomArchetypeSlots } from "../src/workflow/custom-archetype-checks.js";
import { fakeRouterSequence, makePromptStore } from "./test-helpers.js";

/**
 * `05f-author-custom-archetype` — the markup step the copy draft was hoisted
 * onto (Phase 5.5, spec §3 B3).
 *
 * This is the half `npm run check:prompts` cannot know: which `skillRef` the
 * class reads, what ceiling it sets, and — the point of the whole hoist — that
 * the two halves of a custom archetype still compose into exactly the object
 * everything downstream already reads.
 *
 * It is deliberately NOT added to `copy-prompt-v17.test.ts`'s `BUMPED` table:
 * that table's dash assertion bans a literal double hyphen, and this prompt has
 * to write `var(--accent)`. `instagram-template-designer@1` is absent from it
 * for the same reason.
 */

const PROMPTS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const readPrompt = (file: string): string => readFileSync(path.join(PROMPTS_ROOT, "instagram-custom-archetype", file), "utf8");

const agentConfig = (): { skillRef: string; maxTokens?: number; maxSteps?: number; allowedTools: readonly string[]; modelPolicy: { policy: string; model: string } } =>
  (new InstagramCustomArchetypeAgent({ router: fakeRouterSequence([]), tools: {}, promptStore: makePromptStore() }) as unknown as {
    config: { skillRef: string; maxTokens?: number; maxSteps?: number; allowedTools: readonly string[]; modelPolicy: { policy: string; model: string } };
  }).config;

describe("InstagramCustomArchetypeAgent (05f-author-custom-archetype)", () => {
  it("prompts/instagram-custom-archetype/1.md exists, is not a stub, and latest.md is byte-identical", () => {
    expect(readPrompt("1.md").length).toBeGreaterThan(2_000);
    expect(readPrompt("latest.md")).toBe(readPrompt("1.md"));
  });

  it("the class reads instagram-custom-archetype@1 and is pinned to a non-premium Sonnet with no tools", () => {
    const config = agentConfig();
    expect(config.skillRef).toBe("instagram-custom-archetype@1");
    expect(config.modelPolicy.policy).toBe("pinned");
    expect(config.modelPolicy.model).toBe("claude-sonnet-4-6");
    // No Opus inside a run, and a fixed one-call bill: the workflow assembles
    // every input, so there is nothing for a tool loop to fetch.
    expect(config.allowedTools).toEqual([]);
    expect(config.maxSteps).toBe(1);
    expect(config.maxTokens).toBe(CUSTOM_ARCHETYPE_MAX_TOKENS);
  });

  it("the markup this step may return fits well inside its own ceiling", () => {
    // Same measured Latin rate as `copy-schema-length.test.ts`: 3.66 characters
    // an output token, fitted over 45 real steps. The maximal markup is 4,000 +
    // 4,000 + 8 slot names + 8 values of 600, which is what `maxTokens` was
    // chosen against rather than guessed at.
    const maximalChars = 4_000 + 4_000 + MAX_CUSTOM_ARCHETYPE_SLOTS * 40 + MAX_CUSTOM_ARCHETYPE_SLOTS * (40 + 600) + 200;
    expect(Math.round(maximalChars / 3.66)).toBeLessThan(CUSTOM_ARCHETYPE_MAX_TOKENS * 0.6);
  });

  it("the brief carries the identity and the markup step cannot change it", () => {
    // The schema is the enforcement: `archetypeId`, `name` and `rationale` are
    // not fields `05f` returns, so a markup step that wanted to rename the
    // design has nowhere to write the new name.
    const markupKeys = Object.keys((CustomArchetypeMarkupSchema as unknown as { _zod: { def: { shape: Record<string, z.ZodType> } } })._zod.def.shape);
    expect(markupKeys.sort()).toEqual(["bodyHtml", "css", "fields", "slots"]);

    const brief = SlideCustomArchetypeBriefSchema.parse({
      archetypeId: "custom_diagonal_split_stat",
      name: "Diagonal split stat",
      rationale: "The two figures have to be read as one ratio, stacked, which no archetype stacks.",
      slots: ["figure", "figureLabel", "note"],
    });
    const markup = CustomArchetypeMarkupSchema.parse({
      bodyHtml: '<div class="ds"><span>{{figure}}</span><p>{{figureLabel}}</p><p>{{note}}</p></div>',
      css: ".ds { display: grid; padding-inline: 64px; }",
      slots: ["figure", "figureLabel", "note"],
      fields: { figure: "38%", figureLabel: "of teams reply within an hour", note: "The rest answer the next morning." },
    });

    // Composed, it is exactly the object `assembleSlidesData`, the promotion
    // path and `custom-archetype-memory.ts` have always read.
    const composed = composeCustomArchetype(brief, markup);
    expect(SlideCustomArchetypeSchema.safeParse(composed).success).toBe(true);
    expect(composed.archetypeId).toBe("custom_diagonal_split_stat");
    expect(composed.bodyHtml).toContain("{{figure}}");
  });

  /**
   * ── THE TWO SAFETY VERDICTS, MOVED HERE WITH THE MECHANISM ──
   *
   * `custom-archetype.test.ts` asserts both of these by driving the whole
   * workflow with a copy turn that carries authored markup. After the hoist
   * that turn cannot carry markup at all, so those two cases would still pass
   * while proving nothing: the slide degrades because the block was stripped,
   * not because the check fired. Coverage moves to where the mechanism moved.
   * Both verdicts are pure functions over the COMPOSED archetype, which is
   * exactly what `05f` produces and what the workflow will validate.
   */
  it("markup smuggling a <script> is still refused, on the composed object 05f produces", () => {
    const composed = composeCustomArchetype(
      SlideCustomArchetypeBriefSchema.parse({
        archetypeId: "custom_bold_diagonal",
        name: "Bold diagonal stat",
        rationale: "no standard archetype gives this figure the full bleed diagonal treatment",
        slots: ["note"],
      }),
      CustomArchetypeMarkupSchema.parse({
        bodyHtml: '<div class="wrap"><p>{{note}}</p><script>fetch("https://example.test")</script></div>',
        css: ".wrap p { color: var(--accent); }",
        slots: ["note"],
        fields: { note: "a supporting line" },
      }),
    );
    // A VERDICT, not a throw: `assertSafeMarkup` returns `{ ok: false, reason }`
    // so the caller can degrade the slide and keep the reason, which is what
    // `05f`'s failure path needs.
    expect(assertSafeMarkup(composed.bodyHtml, composed.css, composed.slots)).toMatchObject({ ok: false });
  });

  it("markup reading a slot nothing fills is still refused, on the composed object 05f produces", () => {
    const composed = composeCustomArchetype(
      SlideCustomArchetypeBriefSchema.parse({
        archetypeId: "custom_bold_diagonal",
        name: "Bold diagonal stat",
        rationale: "no standard archetype gives this figure the full bleed diagonal treatment",
        slots: ["note"],
      }),
      CustomArchetypeMarkupSchema.parse({
        // `{{missing}}` is declared nowhere and filled by nothing: it would
        // print as literal text on a published slide.
        bodyHtml: '<div class="wrap"><p>{{note}}</p><p>{{missing}}</p></div>',
        css: ".wrap p { color: var(--accent); }",
        slots: ["note"],
        fields: { note: "a supporting line" },
      }),
    );
    expect(validateCustomArchetypeSlots(composed)).toMatchObject({ ok: false });
  });

  it("a ninth field is refused, so the record that had no cap at all now has one", () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < 9; i++) fields[`slot${i}`] = "v";
    const parsed = CustomArchetypeMarkupSchema.safeParse({
      bodyHtml: "<div>{{slot0}}</div>",
      css: "",
      slots: ["slot0"],
      fields,
    });
    expect(parsed.success).toBe(false);
  });
});

