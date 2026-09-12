import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { NativeEditorVerdictSchema, type NativeEditorVerdict } from "../workflow/language-gate.js";

/**
 * Instagram Phase 4 (RFC-15 §6), step `07f-language-fluency-attempt-N`: the
 * NATIVE EDITOR. Reads a drafted carousel in the client's target language and
 * returns, per axis, whether a native reader would clock it — and, for every
 * axis it does not pass, the exact span it objects to and the sentence a
 * native writer would have written instead.
 *
 * ## Why this is a `BaseAgent` subclass and not a `DynamicAgent`
 *
 * Phase 0's fluency judge was a `DynamicAgent` over the flat field DSL, and
 * that DSL is `z.enum(["string", "number", "boolean", "string[]"])` —
 * `AgentDefinitionFieldSchema` in `packages/core/src/agent-definitions/types.ts`
 * has no `object[]` and `buildOutputSchema` has no branch for one. A
 * correction that carries an anchor, a replacement, an axis and a severity is
 * therefore NOT EXPRESSIBLE in it. Corrections are the whole point of this
 * phase — the plan's `gate.nativeLanguage` is "a judge with a rubric and
 * examples that RETURNS TO WRITING rather than only reporting" — so the judge
 * has to be a real class with a zod `outputSchema`. That is the single fact
 * that decides this file's existence.
 *
 * ## Why the class id changed
 *
 * `instagram-language-fluency` -> `instagram-native-editor`, deliberately
 * (RFC-15 decision 9). The step moves vendor `anthropic` -> `gemini`, and a
 * stale Studio `stageModels` override stored under the OLD id holding a Claude
 * model would make `assertModelCatalogued` throw on vendor mismatch the first
 * time this step ran for that client. A new class id inherits no override.
 *
 * `allowedTools: []` — a judgment over text already in hand, and a verifier
 * that can call tools is a verifier that can be steered (the same reasoning
 * the fluency judge, the relevance judge and `runTopicGuardrail`'s verifier
 * all record). `maxSteps: 1`: one turn, one structured verdict, no tool loop.
 */
export class InstagramNativeEditorAgent extends BaseAgent<NativeEditorVerdict> {
  protected readonly config: AgentStepConfig<NativeEditorVerdict> = {
    id: "instagram-native-editor",
    description:
      "Judge whether a drafted Instagram carousel reads as writing by a native speaker of the client's language — across translationese, grammar, register, terminology, convention and idiom — and return every finding as a quoted span plus the replacement a native writer would have used.",
    allowedTools: [],
    outputSchema: NativeEditorVerdictSchema,
    maxSteps: 1,
    // ~$0.014/attempt on non-English runs only: gemini-2.5-pro at $1.25/$10 per 1M,
    // ~6.0k in (rubric 1.5k + register card 0.45k + 4 few-shot posts 2.0k + the draft 1.7k
    // + gate.nativeLanguage's soft tells 0.2k + scaffolding 0.15k) and ~0.65k out (up to 8
    // corrections at ~70 tokens each plus the verdict). It is the CHEAPEST non-premium row in
    // the catalog rated multilingual-strong + rtlSupport strong; `gemini-3.1-pro-preview`
    // also qualifies, at $2/$12. The two Opus rows qualify too and are banned.
    // `no-premium-models.test.ts` derives the cheapest-qualifying claim from the catalog
    // and the pricing table rather than restating it, so a future cheaper row speaks up. It replaces a $0.0055 Haiku call
    // rated `basic` on both dimensions — +$0.0085/attempt to stop asking a basic model about
    // idiom, against $0.240 for the redraft a wrong verdict costs.
    //
    // NOT Opus, at any tier. `claude-opus-4-8` on this call is $0.046, and on the five steps
    // that carry `contentLanguageSensitive` it is a ~$2.9 run against a $1.50 hard max.
    // See RFC-15 §8.
    //
    // `contentLanguageSensitive` is FALSE, unlike every other reader-facing step in this
    // agent: `applyClientLanguagePolicy` re-points such a step to the cheapest same-vendor
    // `multilingual-strong` row, and this step is ALREADY pinned to the model that
    // requirement would select. Letting the policy move it could only move it somewhere
    // worse.
    modelPolicy: resolveModelPolicy("instagram-native-editor", {
      policy: "pinned",
      vendor: "gemini",
      model: "gemini-2.5-pro",
      contentLanguageSensitive: false,
    }),
    skillRef: "instagram-native-editor@1",
  };
}
