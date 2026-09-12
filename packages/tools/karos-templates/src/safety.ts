/**
 * The one archetypeId `materializeTemplates` treats specially (skipped from
 * the write loop, routed to the client's own base file instead — see
 * `materialize.ts`), plus the five bundled structured archetypes. A
 * run-authored custom archetype's file lands in the exact same per-run
 * directory these do; if its id ever collided with one of these, the write
 * would silently overwrite a real template file mid-run and corrupt
 * rendering for every other slide in that carousel using it.
 */
export const LEGACY_ARCHETYPE_IDS: ReadonlySet<string> = new Set([
  "photo",
  "stat_callout",
  "quote_card",
  "comparison_card",
  "list_takeaway",
  "headline_focus",
  // Phase 2, item M: `cover` and `closer` ship as bundled files in exactly
  // the same per-run directory, so the collision guard has to know them or a
  // `custom_`-prefixed archetype could overwrite one mid-run — the hazard
  // this set exists for, now with two more files to protect.
  "cover",
  "closer",
]);

/**
 * Tags and attributes that never belong in a run-generated archetype
 * fragment, matched case-insensitively and in both open and close form.
 * `script`/`style`/`link`/`iframe`/`object`/`embed` are the obvious
 * script/resource-loading vectors; `meta` (a meta-refresh redirect), `base`
 * (hijacks every relative URL on the page), `form`, and `svg`/`math` (both
 * historically used to smuggle event handlers past naive tag filters) are
 * less obvious but just as real once this markup can be authored by a model
 * whose input — scraped research content — is not fully trusted.
 */
const FORBIDDEN_TAGS = /<\/?\s*(script|style|link|iframe|object|embed|meta|base|form|svg|math)\b/i;

const FORBIDDEN_ATTRS = /\bstyle\s*=|\bon\w+\s*=/i;

/**
 * Browsers strip ASCII tab/newline/CR from inside a `javascript:` URL before
 * executing it, so `java\tscript:` still runs even though it doesn't
 * literally contain the substring `javascript:`. Stripped before this check
 * (and before the attribute check above) runs, for the same reason.
 */
function stripUrlWhitespace(value: string): string {
  return value.replace(/[\t\n\r]/g, "");
}

function hasDangerousUrlScheme(value: string): boolean {
  const stripped = stripUrlWhitespace(value).toLowerCase();
  return stripped.includes("javascript:") || stripped.includes("@import") || stripped.includes("url(");
}

/**
 * Every `{{key}}`-shaped placeholder actually present in a fragment.
 *
 * Deliberately only the plain `{{key}}` form — `{{html:key}}` and
 * `{{image:key}}` are never permitted from model-authored content (see
 * `assertSafeMarkup`'s own doc comment), so a fragment that contains either
 * fails validation regardless of what this extracts.
 */
function placeholderKeys(bodyHtml: string): string[] {
  return [...bodyHtml.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]!);
}

/** Every `{{html:key}}` / `{{image:key}}` name a fragment reaches for, with its form, so a refusal can name the offending slot rather than the whole class. */
function privilegedPlaceholders(bodyHtml: string): Array<{ form: "html" | "image"; key: string }> {
  return [...bodyHtml.matchAll(/\{\{(html|image):([A-Za-z0-9_]+)\}\}/gi)].map((m) => ({
    form: m[1]!.toLowerCase() as "html" | "image",
    key: m[2]!,
  }));
}

/**
 * The OPT-IN half of the privileged-slot contract (Phase 2, item N gate 3).
 *
 * `{{html:...}}` and `{{image:...}}` are the renderer's own privileged
 * substitution forms — raw unescaped markup and a bounds-checked local file
 * path — and a run-authored `custom` archetype must never reach for either
 * (see `assertSafeMarkup`'s doc comment). A Template Studio cover, though,
 * cannot exist without `{{image:hero}}`, and a studio template that carries a
 * number device cannot exist without `{{html:device}}`: the ground and the
 * device fragment are BUILT BY CODE, and the slot is how code hands its own
 * output to the document.
 *
 * So the caller states, per template, exactly which privileged names it is
 * prepared to fill — `{ allowImageSlots: ["hero"] }` only when that template
 * declared an image ground, `{ allowHtmlSlots: ["device"] }` only when it
 * declared that slot. Passing NOTHING keeps today's stricter contract, which
 * is what every run-authored custom archetype keeps doing: the permission is
 * a decision at one call site, never a property of the markup.
 */
export interface SafeMarkupOptions {
  /** `{{image:<name>}}` names this template is allowed to read. Anything else is still refused. */
  allowImageSlots?: readonly string[];
  /** `{{html:<name>}}` names this template is allowed to read. Anything else is still refused. */
  allowHtmlSlots?: readonly string[];
}

/**
 * The machine-enforced half of a custom archetype's safety boundary — the
 * other half is that `promoteTemplate` is only ever reachable from a human
 * approval path (see `promote.ts`'s own doc comment). That is enough for a
 * curated template a person hand-writes; it is not enough here, because the
 * copy-drafting step that authors a custom archetype's markup also reads
 * scraped web research content, so its output is influenced by text nobody
 * on this team wrote or reviewed. This is checked before the fragment is
 * ever rendered for a review-gate preview, and again before it is promoted.
 *
 * `bodyHtml` and `css` are fragments, not documents — a full `<script>`/
 * `<style>` document is built separately, by code, in
 * `buildCustomArchetypeDocument`. Anything resembling either tag inside the
 * fragments themselves means the model tried to author its own script or
 * style block rather than using the two designated channels, which is
 * refused outright rather than partially trusted.
 *
 * Only the plain `{{key}}` substitution form is permitted from model
 * content — `{{html:key}}` (raw, unescaped markup) and `{{image:key}}`
 * (a bounds-checked local file path) are the renderer's OWN privileged
 * slots, reserved for first-party fragment builders and image selection
 * respectively; letting a model reach for either would reopen exactly the
 * injection surface `fillTemplate`'s escaped/raw split exists to close.
 *
 * `options` is the ONE way past that (see `SafeMarkupOptions`), and it is
 * per-call rather than per-fragment: a Template Studio template whose ground
 * is an image opts `hero` in explicitly, while a run-authored custom
 * archetype passes no options at all and keeps the stricter contract
 * verbatim.
 */
export function assertSafeMarkup(
  bodyHtml: string,
  css: string,
  slots: readonly string[],
  options: SafeMarkupOptions = {},
): { ok: true } | { ok: false; reason: string } {
  if (css.includes("<")) {
    return { ok: false, reason: "css must not contain '<' — CSS never legitimately needs it, and it is how a value could break out of the <style> block composeDocument splices it into" };
  }
  if (hasDangerousUrlScheme(css)) {
    return { ok: false, reason: "css must not contain 'javascript:', '@import', or 'url(' — presentation must come from the shared design tokens, not an external or injected resource" };
  }

  if (FORBIDDEN_TAGS.test(bodyHtml)) {
    return { ok: false, reason: "bodyHtml must not contain a <script>/<style>/<link>/<iframe>/<object>/<embed>/<meta>/<base>/<form>/<svg>/<math> tag — it is a markup fragment, not a document" };
  }
  if (FORBIDDEN_ATTRS.test(bodyHtml)) {
    return { ok: false, reason: "bodyHtml must not contain an inline style= attribute or an on*= event handler" };
  }
  if (hasDangerousUrlScheme(bodyHtml)) {
    return { ok: false, reason: "bodyHtml must not contain 'javascript:', '@import', or 'url('" };
  }
  const allowedImageSlots = new Set(options.allowImageSlots ?? []);
  const allowedHtmlSlots = new Set(options.allowHtmlSlots ?? []);
  for (const { form, key } of privilegedPlaceholders(bodyHtml)) {
    const allowed = form === "image" ? allowedImageSlots : allowedHtmlSlots;
    if (!allowed.has(key)) {
      const option = form === "image" ? "allowImageSlots" : "allowHtmlSlots";
      const permitted = [...allowed];
      return {
        ok: false,
        reason:
          `bodyHtml uses {{${form}:${key}}}, a reserved first-party-only substitution form. ` +
          (permitted.length > 0
            ? `This template opted in to ${option}: ${permitted.join(", ")} — "${key}" is not one of them.`
            : `Only a caller that fills the slot itself may opt in via ${option}, and this one did not.`),
      };
    }
  }

  const allowed = new Set([...slots, "kicker", "dir"]);
  for (const key of placeholderKeys(bodyHtml)) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `bodyHtml references {{${key}}}, which is not a declared slot (declared: ${slots.join(", ") || "none"})` };
    }
  }

  return { ok: true };
}

/**
 * The shell every bundled archetype template already shares (doctype/head/
 * meta/Google Fonts/`:root` design tokens/reset/fixed 1080x1440 canvas),
 * wrapping a validated custom-archetype `bodyHtml` fragment into a complete,
 * self-contained document — the shape `composeDocument`/`materializeTemplates`
 * expect `htmlTemplate` to already be in.
 *
 * The ready-flag script is written here, by code, and is never something the
 * model supplies — `assertSafeMarkup` refuses any `<script>` in `bodyHtml`
 * for exactly this reason: the one script every rendered slide needs is the
 * harness's to write, not the model's.
 */
export function buildCustomArchetypeDocument(bodyHtml: string): string {
  return buildTemplateShell("instagram-agent custom archetype", bodyHtml);
}

/**
 * The same code-owned shell, for a Template Studio row (Phase 2, item N).
 *
 * The studio's designer agent authors a `bodyHtml` fragment and a stylesheet
 * — never a document, and never the ready-flag script. That split is not
 * style: `publish.renderCarousel` waits on `window.__CAROUSEL_READY__`
 * before it screenshots, so a model that forgot the flag would hang the
 * render, and one that set it too early would screenshot an unpainted page.
 * Neither is a content judgment a validation gate could make, so the flag is
 * never the model's to write.
 *
 * Deliberately a separate export from `buildCustomArchetypeDocument` rather
 * than a shared alias: the two differ in provenance (a run's one-off
 * proposal vs a stored, human-approvable asset), the trace names which one
 * built a document, and a future divergence in the shell — a studio row is
 * allowed an `{{image:hero}}` ground, a custom archetype is not — has a
 * place to land that does not touch the run-authored path.
 */
export function buildStudioTemplateDocument(bodyHtml: string): string {
  return buildTemplateShell("instagram-agent studio template", bodyHtml);
}

function buildTemplateShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en" dir="{{dir}}">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,500;0,600;1,400;1,500;1,600&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #17181C;
    --fg: #F4F2EC;
    --accent: {{accentColor}};
    --accent-ink: #141414;
    --f-display: 'Fraunces', Georgia, 'Times New Roman', serif;
    --f-body: 'Inter', system-ui, -apple-system, sans-serif;
    --f-mono: 'IBM Plex Mono', ui-monospace, monospace;
    --mx: 64px;
    --ts: 1;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1080px; height: 1440px; }
  body { position: relative; overflow: hidden; background: var(--bg); color: var(--fg); font-family: var(--f-body); }
  body.ts-s { --ts: 0.85; }
  body.ts-l { --ts: 1.18; }
  body.ta-center { text-align: center; }
  body.ta-end { text-align: end; }
</style>
</head>
<body class="ts-{{fontScale}} ta-{{textAlign}}">
<div class="brand-badge">{{seriesBadge}}</div>
<!-- The handle slot is bidi-ISOLATED, the same way the bundled archetypes do
     it. An @handle, a URL and a #hashtag are LTR strings whose leading
     character is a bidi neutral, so inside a Hebrew or Arabic document they
     take the paragraph's own RTL embedding level and lay out as "karoslabs@".
     dir on the <bdi> rather than on the <div>, because the div's own
     inset-inline-start would re-resolve with it and move the watermark to
     the opposite corner. -->
<div class="brand-handle"><bdi dir="ltr">{{brandHandle}}</bdi></div>
${bodyHtml}
<script>
  window.__CAROUSEL_READY__ = true;
</script>
</body>
</html>
`;
}
