import type { NewsletterPostOutput } from "../agent/newsletter-draft-agent.js";

/**
 * The email-safe HTML render of an edition (2026-09-05).
 *
 * The edition's `text` is markdown the portal renders on screen; a subscriber
 * never sees markdown. This turns the same structured fields the model wrote
 * (`intro`, `sections`, `callToAction`, `signoff`) plus the platform-injected
 * compliance footer into one standalone document a customer can paste into any
 * email platform and send: table layout, every style inline, 600px fixed
 * width, no JavaScript, no external CSS, no SVG, no web fonts. Two themes from
 * one input so they can never disagree.
 *
 * Deterministic and pure: the same draft, brand and date render to the same
 * bytes, which is what lets the workflow run it as a checkpointed code step
 * and what makes it testable without a browser. Every string the model or the
 * client wrote is HTML-escaped before it touches markup; only `http(s)` URLs
 * become links.
 */

export type NewsletterEmailTheme = "light" | "dark";

export interface RenderNewsletterEmailInput {
  /** The edition as it will be sent: the model's fields plus the workflow's injected footer fields. */
  draft: Pick<NewsletterPostOutput, "subjectLine" | "previewText" | "intro" | "sections" | "callToAction" | "signoff" | "footerDisclaimer" | "companyAddress" | "unsubscribeUrl">;
  /** The client's brand kit as `client.getBrand` returns it: `dominantColors`, `colors`, `fonts`, `logoUrl`, `name`, ... Read defensively; every field is optional. */
  brand: Record<string, unknown>;
  /** The client's profile (`name`, `website`), for the masthead fallback when the brand kit names nothing. */
  profile: Record<string, unknown>;
  /** A short human date label for the masthead ("5 Sep 2026"). Omitted when the caller has none. */
  issueDate?: string;
  theme: NewsletterEmailTheme;
}

export interface RenderedNewsletterEmail {
  theme: NewsletterEmailTheme;
  html: string;
  /** UTF-8 size of `html`. */
  bytes: number;
  /** Gmail clips a message past ~102 KB and hides the rest behind "View entire message", footer and unsubscribe link included. */
  gmailClipRisk: boolean;
  direction: "ltr" | "rtl";
}

/** Gmail's clipping threshold, in bytes. */
export const GMAIL_CLIP_BYTES = 102 * 1024;
const EMAIL_WIDTH = 600;

// ── colour maths ────────────────────────────────────────────────────────────

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(raw: unknown): Rgb | undefined {
  if (typeof raw !== "string") return undefined;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m) return undefined;
  let hex = m[1]!;
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const n = Number.parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Relative luminance, 0 (black) to 1 (white). */
function luminance({ r, g, b }: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

interface Palette {
  page: string;
  card: string;
  text: string;
  muted: string;
  rule: string;
  accent: string;
  accentText: string;
  link: string;
}

/**
 * The client's own colours, read from the brand kit the portal projects
 * (`dominantColors: [{hex, dominanceRank, role}]`), falling back through the
 * older scalar fields. Everything the email needs that the brand does not
 * name (page ground, hairlines, muted text) is computed from the client's own
 * palette, never taken from a fixed list.
 */
function resolveBrandColours(brand: Record<string, unknown>): { accent: Rgb; ink: Rgb } {
  const dominant = Array.isArray(brand["dominantColors"])
    ? [...(brand["dominantColors"] as Array<Record<string, unknown>>)]
        .filter((c) => c && typeof c === "object")
        .sort((a, b) => Number(a["dominanceRank"] ?? 99) - Number(b["dominanceRank"] ?? 99))
        .map((c) => parseHex(c["hex"]))
        .filter((c): c is Rgb => c !== undefined)
    : [];
  const flat = Array.isArray(brand["colors"]) ? (brand["colors"] as unknown[]).map(parseHex).filter((c): c is Rgb => c !== undefined) : [];
  const scalars = [brand["primaryAccent"], brand["primaryColor"], brand["accent"]].map(parseHex).filter((c): c is Rgb => c !== undefined);
  const candidates = [...dominant, ...flat, ...scalars];

  // The accent is the most dominant colour that can carry a button: not near-white.
  const accent = candidates.find((c) => luminance(c) < 0.8) ?? { r: 17, g: 24, b: 39 };
  // The ink is the first genuinely dark colour after the accent, else a neutral charcoal.
  const ink = candidates.find((c) => c !== accent && luminance(c) < 0.2) ?? { r: 23, g: 23, b: 26 };
  return { accent, ink };
}

function palette(brand: Record<string, unknown>, theme: NewsletterEmailTheme): Palette {
  const { accent, ink } = resolveBrandColours(brand);
  const accentText = luminance(accent) > 0.45 ? toHex(ink) : "#ffffff";
  if (theme === "light") {
    return {
      page: "#f4f4f5",
      card: "#ffffff",
      text: toHex(mix(ink, BLACK, 0.2)),
      muted: "#6b7280",
      rule: "#e5e7eb",
      accent: toHex(accent),
      accentText,
      // A very light accent is unreadable as link text on white; pull it toward the ink.
      link: luminance(accent) > 0.55 ? toHex(mix(accent, ink, 0.6)) : toHex(accent),
    };
  }
  const page = toHex(ink);
  const card = toHex(mix(ink, WHITE, 0.06));
  return {
    page,
    card,
    text: "#f4f4f5",
    muted: "#a1a1aa",
    rule: toHex(mix(ink, WHITE, 0.18)),
    accent: toHex(accent),
    accentText,
    // A dark accent vanishes on a dark ground; lift it until it reads.
    link: luminance(accent) < 0.25 ? toHex(mix(accent, WHITE, 0.45)) : toHex(accent),
  };
}

// ── text → safe HTML ─────────────────────────────────────────────────────────

function escapeHtml(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Only absolute http(s) URLs become links; anything else is rendered as the text it is. */
function safeHref(raw: string): string | undefined {
  const url = raw.trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(url)) return undefined;
  return escapeHtml(url);
}

/** Bold and links, on already-escaped text. The only inline markdown the craft guide allows. */
function inlineMarkdown(escaped: string, p: Palette): string {
  return escaped
    .replace(/\[([^\]\n]+)\]\(\s*(https?:\/\/[^)\s]+)\s*\)/g, (_m, label: string, url: string) => {
      const href = safeHref(url.replace(/&amp;/g, "&"));
      return href ? `<a href="${href}" style="color:${p.link};text-decoration:underline;">${label}</a>` : label;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

type Font = { heading: string; body: string };

function fonts(brand: Record<string, unknown>): Font {
  const f = (brand["fonts"] ?? {}) as Record<string, unknown>;
  const safe = (name: unknown, fallback: string) => {
    const n = typeof name === "string" ? name.trim().replace(/["';{}<>]/g, "") : "";
    return n.length > 0 ? `'${n}', ${fallback}` : fallback;
  };
  const bodyStack = "Helvetica, Arial, sans-serif";
  return { heading: safe(f["heading"], bodyStack), body: safe(f["body"], bodyStack) };
}

/**
 * The markdown subset a section body may carry (`##` headings, `**bold**`,
 * `- ` bullets, `[label](url)` links, blank-line paragraphs) as table-safe
 * HTML with every style inline.
 */
function bodyToHtml(body: string, p: Palette, f: Font, align: "left" | "right"): string {
  const para = (inner: string) => `<p style="margin:0 0 14px;font-family:${f.body};font-size:16px;line-height:1.6;color:${p.text};text-align:${align};">${inner}</p>`;
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push(para(paragraph.join(" ")));
    paragraph = [];
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push(
        `<ul style="margin:0 0 14px;padding-${align === "left" ? "left" : "right"}:22px;font-family:${f.body};font-size:16px;line-height:1.6;color:${p.text};text-align:${align};">${list
          .map((item) => `<li style="margin:0 0 6px;">${item}</li>`)
          .join("")}</ul>`,
      );
    }
    list = [];
  };

  for (const rawLine of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^#{2,6}\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(`<h3 style="margin:18px 0 8px;font-family:${f.heading};font-size:17px;line-height:1.35;font-weight:600;color:${p.text};text-align:${align};">${inlineMarkdown(escapeHtml(heading[1]!), p)}</h3>`);
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      list.push(inlineMarkdown(escapeHtml(bullet[1]!), p));
      continue;
    }
    flushList();
    paragraph.push(inlineMarkdown(escapeHtml(line), p));
  }
  flushParagraph();
  flushList();
  return blocks.join("");
}

// ── the document ─────────────────────────────────────────────────────────────

/** Hebrew, Arabic, Syriac, Thaana: the edition reads right to left. */
const RTL_SCRIPT = /[֐-ࣿ]/;

function brandName(brand: Record<string, unknown>, profile: Record<string, unknown>): string {
  for (const v of [brand["name"], profile["name"]]) if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return "";
}

export function renderNewsletterEmail(input: RenderNewsletterEmailInput): RenderedNewsletterEmail {
  const { draft, brand, profile, theme } = input;
  const p = palette(brand, theme);
  const f = fonts(brand);
  const direction: "ltr" | "rtl" = RTL_SCRIPT.test(`${draft.subjectLine}\n${draft.intro}`) ? "rtl" : "ltr";
  const align = direction === "rtl" ? "right" : "left";
  const name = brandName(brand, profile);
  const logoHref = typeof brand["logoUrl"] === "string" ? safeHref(brand["logoUrl"]) : undefined;
  const subject = escapeHtml(draft.subjectLine);

  const masthead = `
<tr>
  <td style="padding:28px 32px 8px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="vertical-align:middle;text-align:${align};">
          ${logoHref ? `<img src="${logoHref}" alt="${escapeHtml(name)}" height="32" style="display:inline-block;height:32px;max-width:220px;border:0;outline:none;text-decoration:none;">` : `<span style="font-family:${f.heading};font-size:15px;font-weight:700;letter-spacing:0.02em;color:${p.text};">${escapeHtml(name)}</span>`}
        </td>
        ${input.issueDate ? `<td style="vertical-align:middle;text-align:${align === "left" ? "right" : "left"};font-family:${f.body};font-size:12px;color:${p.muted};">${escapeHtml(input.issueDate)}</td>` : ""}
      </tr>
    </table>
    <div style="height:1px;line-height:1px;font-size:1px;background:${p.rule};margin-top:16px;">&nbsp;</div>
  </td>
</tr>`;

  const intro = `
<tr>
  <td style="padding:20px 32px 4px;">
    <p style="margin:0 0 14px;font-family:${f.body};font-size:17px;line-height:1.6;color:${p.text};text-align:${align};">${inlineMarkdown(escapeHtml(draft.intro), p)}</p>
  </td>
</tr>`;

  const sections = draft.sections
    .map((section) => {
      const href = section.linkUrl ? safeHref(section.linkUrl) : undefined;
      const more = href ? `<p style="margin:0 0 6px;font-family:${f.body};font-size:14px;line-height:1.5;text-align:${align};"><a href="${href}" style="color:${p.link};text-decoration:underline;">Read the full story</a></p>` : "";
      return `
<tr>
  <td style="padding:12px 32px 6px;">
    <h2 style="margin:0 0 10px;font-family:${f.heading};font-size:21px;line-height:1.3;font-weight:700;color:${p.text};text-align:${align};">${inlineMarkdown(escapeHtml(section.heading), p)}</h2>
    ${bodyToHtml(section.body, p, f, align)}${more}
  </td>
</tr>`;
    })
    .join("");

  const ctaHref = safeHref(draft.callToAction.url);
  const ctaLabel = escapeHtml(draft.callToAction.text);
  const cta = `
<tr>
  <td style="padding:18px 32px 10px;text-align:${align};">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;">
      <tr>
        <td style="border-radius:6px;background:${p.accent};">
          ${
            ctaHref
              ? `<a href="${ctaHref}" style="display:inline-block;padding:12px 22px;font-family:${f.body};font-size:15px;font-weight:600;line-height:1.2;color:${p.accentText};text-decoration:none;border-radius:6px;">${ctaLabel}</a>`
              : `<span style="display:inline-block;padding:12px 22px;font-family:${f.body};font-size:15px;font-weight:600;line-height:1.2;color:${p.accentText};">${ctaLabel}</span>`
          }
        </td>
      </tr>
    </table>
  </td>
</tr>`;

  const signoff = `
<tr>
  <td style="padding:14px 32px 26px;">
    <p style="margin:0;font-family:${f.body};font-size:16px;line-height:1.6;color:${p.text};text-align:${align};">${inlineMarkdown(escapeHtml(draft.signoff), p)}</p>
  </td>
</tr>`;

  const footerLines: string[] = [];
  if (draft.footerDisclaimer) footerLines.push(escapeHtml(draft.footerDisclaimer));
  if (draft.companyAddress) footerLines.push(escapeHtml(draft.companyAddress));
  const unsubscribeHref = draft.unsubscribeUrl ? safeHref(draft.unsubscribeUrl) : undefined;
  if (unsubscribeHref) footerLines.push(`<a href="${unsubscribeHref}" style="color:${p.muted};text-decoration:underline;">Unsubscribe</a>`);
  else if (draft.unsubscribeUrl) footerLines.push(escapeHtml(draft.unsubscribeUrl));
  const footer =
    footerLines.length > 0
      ? `
<tr>
  <td style="padding:18px 32px 28px;">
    ${footerLines.map((line) => `<p style="margin:0 0 6px;font-family:${f.body};font-size:12px;line-height:1.5;color:${p.muted};text-align:${align};">${line}</p>`).join("")}
  </td>
</tr>`
      : "";

  const preheader = `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(draft.previewText)}</div>`;

  const html = `<!DOCTYPE html>
<html lang="${direction === "rtl" ? "he" : "en"}" dir="${direction}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="${theme}">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:${p.page};">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${p.page};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:${EMAIL_WIDTH}px;max-width:${EMAIL_WIDTH}px;background:${p.card};border-radius:10px;">
        ${masthead}${intro}${sections}${cta}
        <tr><td style="padding:0 32px;"><div style="height:1px;line-height:1px;font-size:1px;background:${p.rule};">&nbsp;</div></td></tr>
        ${signoff}${footer}
      </table>
    </td>
  </tr>
</table>
</body>
</html>
`;

  const bytes = Buffer.byteLength(html, "utf8");
  return { theme, html, bytes, gmailClipRisk: bytes > GMAIL_CLIP_BYTES, direction };
}

/** Both themes from one input, so they can never carry different content. */
export function renderNewsletterEmails(input: Omit<RenderNewsletterEmailInput, "theme">): { light: RenderedNewsletterEmail; dark: RenderedNewsletterEmail } {
  return { light: renderNewsletterEmail({ ...input, theme: "light" }), dark: renderNewsletterEmail({ ...input, theme: "dark" }) };
}
