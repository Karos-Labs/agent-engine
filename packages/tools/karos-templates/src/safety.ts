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
 */
export function assertSafeMarkup(
  bodyHtml: string,
  css: string,
  slots: readonly string[],
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
  if (/\{\{(?:html|image):/i.test(bodyHtml)) {
    return { ok: false, reason: "bodyHtml must not use {{html:...}} or {{image:...}} — those are reserved, first-party-only substitution forms" };
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
  return `<!doctype html>
<html lang="en" dir="{{dir}}">
<head>
<meta charset="utf-8" />
<title>instagram-agent custom archetype</title>
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
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1080px; height: 1440px; }
  body { position: relative; overflow: hidden; background: var(--bg); color: var(--fg); font-family: var(--f-body); }
</style>
</head>
<body>
${bodyHtml}
<script>
  window.__CAROUSEL_READY__ = true;
</script>
</body>
</html>
`;
}
