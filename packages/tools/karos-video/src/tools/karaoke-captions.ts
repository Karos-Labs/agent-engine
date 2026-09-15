import { z } from "zod";
import { hexToAss, sanitizeAssText } from "./clip-compose.js";

/**
 * Word-highlight ("karaoke") captions as ONE libass script (2026-09-15).
 *
 * The captions an original short burned until now were an SRT: three or four
 * words, white on a black outline, the whole phrase appearing and vanishing
 * at once. That is subtitle grammar. The grammar of a short on TikTok is a
 * phrase that stays up while the word being SAID lights up in the brand's
 * accent and steps forward a little; a viewer with the sound off follows
 * the voice through the picture, and a viewer with it on reads ahead by one
 * word. Every input for it already existed: the script's own words are the
 * text (`captions.ts` in the tiktok agent), the voice's transcript is the
 * clock, and the phrase grouping is unchanged. What was missing was a
 * caption format that can address one word at a time — libass can.
 *
 * ## How it is built
 *
 * Not `\k` karaoke tags: those recolour the words already sung and leave the
 * rest in a second colour, which is the look of a karaoke bar, not of a
 * short. Instead, one `Dialogue` event PER WORD STATE: for a phrase of N
 * words there are N events, each showing the whole phrase with word k set in
 * the accent colour and scaled up by `HIGHLIGHT_SCALE`, from that word's
 * start until the next word's start (the last one until the phrase ends).
 * All the other words stay white. Events never overlap (each starts where
 * the previous ends), so libass draws exactly one phrase at any instant.
 *
 * A short of 80 words is 80 events, about 12 KB of text. Rendering cost is
 * libass drawing one line per frame either way; there is no model anywhere
 * in this.
 *
 * `PlayResX/Y` is the canvas, so every size and margin is in output pixels —
 * the same convention `buildFurnitureAss` uses, and NOT the SRT path's, where
 * ffmpeg's 384x288 script scaling made `fontSize: 13` mean ~87 px.
 */

/** How much the word being said grows: 1.08 = a step forward, not a jump. */
export const HIGHLIGHT_SCALE = 1.08;

export const KaraokeWordSchema = z.object({
  text: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
export type KaraokeWord = z.infer<typeof KaraokeWordSchema>;

/** One phrase on screen: its words in order, each timed. `end` is when the phrase leaves (usually the last word's end, stretched to a legible minimum). */
export const KaraokePhraseSchema = z.object({
  words: z.array(KaraokeWordSchema).min(1),
  end: z.number().nonnegative(),
});
export type KaraokePhrase = z.infer<typeof KaraokePhraseSchema>;

export const KaraokeCaptionStyleSchema = z.object({
  fontName: z.string().min(1).default("Liberation Sans").describe("fontconfig family; the server image ships Liberation, DejaVu and Noto."),
  fontSizePx: z.number().int().positive().default(84).describe("Caption size in canvas pixels. 84 on a 1920 canvas matches the SRT path's 13 script units."),
  outlinePx: z.number().nonnegative().default(7).describe("Black outline width in canvas pixels."),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe("The colour the word being said is set in — the brand accent. Every other word is white."),
  canvas: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }).default(() => ({ w: 1080, h: 1920 })),
  barHeight: z.number().int().nonnegative().default(200).describe("The bottom brand bar's height; the block sits above it."),
  gapAboveBarPx: z.number().int().nonnegative().default(56).describe("Canvas pixels between the caption block and the top of the bottom bar."),
  marginXPx: z.number().int().nonnegative().default(60),
});
export type KaraokeCaptionStyle = z.infer<typeof KaraokeCaptionStyleSchema>;

function assTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.round((clamped - Math.floor(clamped)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(Math.min(cs, 99)).padStart(2, "0")}`;
}

/** The text of one event: the phrase with word `lit` in the accent, scaled, then the style restored (`\r`). */
export function karaokeEventText(words: readonly string[], lit: number, accentAss: string): string {
  const pct = Math.round(HIGHLIGHT_SCALE * 100);
  return words
    .map((w, i) => {
      const clean = sanitizeAssText(w);
      return i === lit ? `{\\1c${accentAss}\\fscx${pct}\\fscy${pct}}${clean}{\\r}` : clean;
    })
    .join(" ");
}

/**
 * The whole script. Returns `undefined` when there is nothing to show (no
 * phrase with a word in it), so the caller burns nothing rather than an
 * empty file.
 */
export function buildKaraokeCaptionsAss(phrases: readonly KaraokePhrase[], styleInput: Partial<KaraokeCaptionStyle> & { accent: string }): string | undefined {
  const style = KaraokeCaptionStyleSchema.parse(styleInput);
  const usable = phrases.filter((p) => p.words.length > 0 && p.words.some((w) => sanitizeAssText(w.text).length > 0));
  if (usable.length === 0) return undefined;
  const { w, h } = style.canvas;
  const white = "&H00FFFFFF";
  const black = "&H00000000";
  const accent = hexToAss(style.accent);
  const marginV = style.barHeight + style.gapAboveBarPx;
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${style.fontName},${style.fontSizePx},${white},${white},${black},${black},-1,0,0,0,100,100,0,0,1,${style.outlinePx},0,2,${style.marginXPx},${style.marginXPx},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  for (const phrase of usable) {
    const texts = phrase.words.map((word) => word.text);
    for (let k = 0; k < phrase.words.length; k++) {
      const word = phrase.words[k]!;
      const next = phrase.words[k + 1];
      const start = word.start;
      // Each state runs until the next word starts, so the highlight never
      // lags behind the voice and never leaves a gap; the last word holds the
      // phrase until it leaves.
      const end = next !== undefined ? Math.max(next.start, start + 0.01) : Math.max(phrase.end, start + 0.05);
      if (end <= start) continue;
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${karaokeEventText(texts, k, accent)}`);
    }
  }
  return lines.join("\n") + "\n";
}
