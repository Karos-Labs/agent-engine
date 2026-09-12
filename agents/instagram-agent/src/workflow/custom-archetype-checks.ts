import { extractSupportedFields } from "@agent-engine/tool-karos-templates";
import type { SlideCustomArchetype } from "./types.js";

/**
 * RFC-13 Phase 2, item O — THE SLOT CONTRACT, checked before a render is
 * spent.
 *
 * `validateCustomArchetypes` already checks two things: that the model's
 * `archetypeId` does not collide with a real archetype (which would let one
 * run's authored file overwrite a bundled one mid-run), and that the markup
 * is safe (`assertSafeMarkup`). Both are about damage. Neither notices the
 * commonest failure of an authored layout, which is not dangerous at all: a
 * `{{key}}` in the markup that the `fields` object never fills.
 *
 * `materializeTemplates` substitutes what it is given and leaves the rest;
 * an unfilled placeholder therefore renders as a literal `{{price}}` on the
 * slide, or as a hole where the element collapsed. Nothing downstream fails,
 * so today that ships. Item L's interest floor would sometimes catch the
 * hole and sometimes not — a missing sub-line on an otherwise full plate
 * measures fine.
 *
 * This check is free, pure and PRE-RENDER, which is what makes item O's
 * "author a layout when the content calls for it" safe to encourage: the
 * common authoring mistake is caught before Chromium starts, and the slide
 * degrades through the same path a `stat_callout` with no `stat` takes.
 *
 * The one thing it deliberately does NOT do is judge the design. Whether the
 * layout is any good is the interest floor's question (item L), measured on
 * the pixels, with `custom-<id>` named in the finding.
 */

/**
 * Every slot name the workflow can actually supply to a template.
 *
 * Derived from `contentFor`'s own outputs in `slides-data.ts` — the standing
 * furniture every archetype gets (`accentColor`, `dir`, `fontScale`,
 * `textAlign`, `kicker`, `brandHandle`, `seriesBadge`), the per-archetype
 * content blocks, the `hero` image slot, and item M's `device`/`recap` html
 * fragments.
 *
 * Held as a literal rather than computed from `contentFor`, because
 * `contentFor` returns a different shape per layout and there is no layout
 * for which it returns all of them at once — a union computed at run time
 * would need a fake slide per archetype to interrogate. The cost of the
 * literal is that it must be extended when `contentFor` grows a field; the
 * benefit is that the check is a pure string-set comparison with no
 * dependency on the layout enum. `default-template-render.test.ts`'s
 * existing source scan over the bundled templates is what would catch a
 * drift here: every `{{name}}` in a shipped template is a name `contentFor`
 * supplies, and this set is a superset of those.
 */
export const KNOWN_SLOT_NAMES: ReadonlySet<string> = new Set([
  // Standing furniture — present on every archetype, whatever its layout.
  "accentColor",
  "dir",
  // Phase 4 (RFC-15 §7.2). All eight bundled templates now open
  // `<html lang="{{lang}}" dir="{{dir}}">`, so this set stops being the
  // promised superset without it — and a model-authored archetype whose
  // markup reads `{{lang}}` would be wrongly refused as "unsuppliable".
  "lang",
  "fontScale",
  "textAlign",
  "kicker",
  "brandHandle",
  "seriesBadge",
  // Item M's four CODE-DERIVED layout-metadata fields (`LAYOUT_FIELD_KEYS`
  // in `visual-qa-pre-checks.ts`): which token-driven ground the slide
  // paints, the numeral the glyph ground sets, the figures a device actually
  // painted, and the KIND of device that painted (which is what `07k`'s
  // skeleton signature reads, so that a device the archetype had no slot for
  // cannot enter the signature). `headline-focus.html` and `closer.html`
  // read the first two, so leaving them out would make this set stop being
  // the superset of every `{{name}}` a shipped template reads that its own
  // doc comment promises. None is content: nothing that counts prose ever
  // sees them.
  "groundStyle",
  "slideIndex",
  "deviceFigures",
  "deviceKind",
  // The two fields every slide always has.
  "headline",
  "body",
  // `stat_callout`.
  "figure",
  "subLabel",
  "sourceLine",
  // `quote_card`.
  "quoteText",
  "attribution",
  // `comparison_card`.
  "leftLabel",
  "leftBody",
  "rightLabel",
  "rightBody",
  // `list_takeaway` (an `html:` fragment, built by `buildListRows`).
  "itemRows",
  // `photo` / `cover` — the hero image.
  "hero",
  // Item M: `cover` and `closer`.
  "eyebrow",
  "title",
  "subtitle",
  "takeaway",
  "cta",
  "question",
  // Item M's device library and the closer's recap strip — both `html:`
  // fragments built by first-party code, never by the model.
  "device",
  "recap",
]);

/** Slots the workflow fills itself (an image selection, a code-built fragment), so `fields` is not expected to carry them. */
const PROVIDED_BY_WORKFLOW: ReadonlySet<string> = new Set(["hero", "device", "recap", "itemRows"]);

/**
 * Does this authored layout read only slots something can fill, and fill
 * every slot it declares?
 *
 * Three clauses, each naming the offending key, because the reason is what
 * reaches the writer through `selfCheckSteer` on the next attempt:
 *
 * 1. Every `{{key}}` the markup or CSS reads is either a declared slot or a
 *    name the workflow supplies anyway (`KNOWN_SLOT_NAMES`).
 * 2. Every declared slot appears somewhere in the markup. A slot declared
 *    and never read is a field the model wrote copy for that no reader will
 *    ever see, which is a quieter version of the same defect.
 * 3. Every declared slot has a value in `fields`. This is the one that
 *    actually renders as a hole.
 *
 * The `hero`, `device` and `recap` names are exempt from clause 3: they are
 * `{{image:hero}}` / `{{html:device}}` slots filled by the workflow's own
 * image selection and fragment builders, not by model-authored `fields` —
 * and `assertSafeMarkup` refuses those forms in a run-authored archetype
 * anyway, so a custom layout cannot reach them. The exemption is here so
 * that widening the safety allowlist later (item N's studio path does
 * exactly that) does not turn this check into a false failure.
 */
export function validateCustomArchetypeSlots(archetype: SlideCustomArchetype): { ok: true } | { ok: false; reason: string } {
  const declared = new Set(archetype.slots);
  const read = extractSupportedFields(`${archetype.bodyHtml}\n${archetype.css}`);

  const unsuppliable = read.filter((name) => !declared.has(name) && !KNOWN_SLOT_NAMES.has(name));
  if (unsuppliable.length > 0) {
    return {
      ok: false,
      reason:
        `reads {{${unsuppliable.join("}}, {{")}}} which it never declares in \`slots\` and which no archetype supplies — ` +
        "an unfilled placeholder renders as a literal on the slide, so declare it and give it a value in `fields`",
    };
  }

  const unread = archetype.slots.filter((name) => !read.includes(name));
  if (unread.length > 0) {
    return {
      ok: false,
      reason: `declares slot(s) ${unread.map((n) => `\`${n}\``).join(", ")} that its own markup never reads — the copy written for them would never appear`,
    };
  }

  const unfilled = archetype.slots.filter((name) => !(name in archetype.fields) && !PROVIDED_BY_WORKFLOW.has(name));
  if (unfilled.length > 0) {
    return {
      ok: false,
      reason: `declares slot(s) ${unfilled.map((n) => `\`${n}\``).join(", ")} with no value in \`fields\` — that renders as a hole where the element should be`,
    };
  }

  return { ok: true };
}
