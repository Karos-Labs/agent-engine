import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { PostPackageSchema, type PostPackage } from "../workflow/post-package.js";

/**
 * Instagram Phase 5 (RFC-18 §6.1), step `08c-package-post`: THE POST PACKAGER.
 *
 * Reads a carousel whose copy has already been drafted, corrected and accepted
 * by every gate that reads it, and writes the three parts of an Instagram post
 * that a set of PNGs and a caption have never had: three to five hashtags, one
 * alt text per shipped slide, and the prose of a first comment that carries the
 * post's sources. Before this step existed a finished Instagram deliverable had
 * **no hashtags at all** (the owner's plan, item 3), no alt text on any slide,
 * and its sourcing visible nowhere a reader could reach.
 *
 * ## Why this is a `BaseAgent` subclass and not a `DynamicAgent`
 *
 * The same single fact that decides `instagram-native-editor-agent.ts`'s
 * existence. `AgentDefinitionFieldSchema` is
 * `z.enum(["string", "number", "boolean", "string[]"])` and `buildOutputSchema`
 * has no `object[]` branch, so `altText: Array<{ n, alt }>` — one entry PER
 * SLIDE, each carrying the slide it belongs to — is not expressible in the flat
 * DSL. Flattening it into two index-aligned `string[]`s was considered and
 * declined: the value gate pays that price for its three fix arrays because a
 * `DynamicAgent` is what a judge is, and it pays for it with a misalignment
 * rule that DISCARDS rows it cannot trust (RFC-18 §5.3). Alt text has no such
 * escape — a dropped alt is a slide a screen reader cannot describe — so the
 * shape is typed instead of reconstructed.
 *
 * ## What it may not do, encoded rather than requested
 *
 * `allowedTools: []`. It writes about a post it has been handed, and a step
 * that can call tools is a step that can go and find a new fact to put in the
 * alt text; every claim, number and name in the package has to be one the post
 * or the fact cards already carry. `maxSteps: 1`: one turn, one structured
 * package, no tool loop.
 *
 * **There is no URL anywhere in `PostPackageSchema`.** The first comment's
 * `sources` are built in code from the fact cards the shipped slides actually
 * cite (`buildFirstCommentSources`, `post-package.ts`), so an invented link is
 * not forbidden here, it is unrepresentable — the same move Phase 4 made when
 * it put `sourceRef`, `stat.figure` and every `source` out of reach of the
 * correction schema. The prompt's §4 states the rule as well, but the schema is
 * what enforces it.
 *
 * ## Cost, and why the packager exists instead of the writer authoring this
 *
 * ~$0.003 PER REVISION, pinned `gemini-2.5-flash` at $0.30/$2.50 per 1M:
 * ~5.3k in (the shipped slides 1.7k + the caption 0.3k + `briefForPrompt` 0.6k
 * + the register card 0.45k + the fact cards 0.8k + the term policy 0.2k + the
 * instructions 1.25k) = $0.0016, and ~0.56k out (hashtags 40 + up to 8 alt
 * texts at ~45 + the comment 120 + scaffolding 40) = $0.0014. Priced as
 * `STEP_COST_ESTIMATES_USD.postPackage`.
 *
 * Authoring the same fields inside `05-write-copy` would cost roughly +520
 * output tokens on EVERY attempt — ~$0.008 x 3 = ~$0.023 a run — and most of
 * that is spent on drafts that are thrown away. One Flash call after the loop
 * breaks is 8x cheaper and it is also more correct: alt text written for a
 * slide a redraft is about to replace is money burned describing a picture
 * nobody will ever see. That is the whole argument for the step's position.
 *
 * NOT a stronger model, and not Opus at any tier (the owner's standing
 * amendment, RFC-18 §8). This is utility prose against a written spec with a
 * free deterministic checker (`08c1-package-checks`) behind it and a native
 * round (`08c2`) behind that; there is no taste judgment here for a bigger
 * model to buy. `gemini-2.5-pro` on this call would be ~$0.009 for the same
 * three fields.
 *
 * `contentLanguageSensitive` is deliberately ABSENT, mirroring
 * `instagram-relevance-judge` and `instagram-native-editor`.
 * `applyClientLanguagePolicy` re-points such a step to the cheapest same-vendor
 * `multilingual-strong` row, which on a Hebrew client would silently move this
 * call to `gemini-2.5-pro` and add ~$0.006 to every non-English run. The
 * NATIVENESS of what comes back is not this step's business: `08c2` runs the
 * real native editor over the package and applies its corrections, which is a
 * better instrument than a bigger drafting model and is already paid for.
 */
export class InstagramPostPackagerAgent extends BaseAgent<PostPackage> {
  protected readonly config: AgentStepConfig<PostPackage> = {
    id: "instagram-post-packager",
    description:
      "Write the three parts of a finished Instagram post that the carousel itself cannot carry: three to five hashtags derived from this client's own brief, one alt text per shipped slide for a reader who cannot see it, and the prose of a first comment introducing where the post's facts came from.",
    allowedTools: [],
    outputSchema: PostPackageSchema,
    maxSteps: 1,
    modelPolicy: resolveModelPolicy("instagram-post-packager", { policy: "pinned", model: "gemini-3.8-flash", vendor: "gemini" }),
    skillRef: "instagram-post-package@2",
  };
}
