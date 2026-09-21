import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { XMLParser } from "fast-xml-parser";
import { defineTool, success, contentFail, notAvailable, toolingError } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX } from "./find-images.js";

// 1.0.0 (2026-09-21): podcasts, from the place podcasts actually live.
//
// `media.harvestVideo` finds an episode by searching YouTube, which is a
// second-hand index of podcasts and is defended against exactly the kind of
// automated download this pipeline does: prep run pubsub-21908845348121079
// found a real podcast and was answered "Sign in to confirm you're not a
// bot". A podcast's own RSS feed has no such defence, because serving the
// audio to any client that asks IS what a podcast feed is for.
// 1.2.0 (2026-09-21): `requireVideo` — take ONLY episodes the show publishes
// on camera. The clip pipeline can cut and frame a video episode with the
// machinery it already has; an audio one needs a composition that is not
// wired yet, and downloading an episode the run cannot use is bandwidth spent
// to learn nothing.
// 1.1.0 (2026-09-21): VIDEO ENCLOSURES ARE PREFERRED. The owner's priority is
// seeing the podcast itself, and a large share of shows publish a video
// enclosure beside the audio one — which is the speakers on camera, from the
// show's own feed, with no bot check between us and it. `media` now says which
// arrived, and the clip pipeline routes on it.
const TOOL_VERSION = "1.2.0";

/**
 * `media.harvestPodcast` — find an episode by topic and download its audio.
 *
 * ## Why this exists beside `media.harvestVideo`
 *
 * They answer different questions. `harvestVideo` asks "is there a video of
 * somebody saying this", and takes whatever YouTube ranks — which for a
 * marketing query is as often a conference recording, a clip farm or a
 * screencast as it is a podcast. This asks "is there a PODCAST about this",
 * and every answer is one by construction: the search index is Apple's
 * podcast directory and the file comes from the show's own feed.
 *
 * The trade is the picture. A feed enclosure is audio, so a clip built from
 * one carries the speakers' real words over sourced footage rather than over
 * the speakers themselves. That is a normal short-form format and it is a
 * strictly better answer than the generated original short the cascade falls
 * to when no footage can be had at all.
 *
 * ## Keyless on purpose
 *
 * Apple's search endpoint needs no key and no account, and the feeds are
 * public HTTP. There is nothing to provision, nothing to rotate, and nothing
 * that can be rate-limited into a client's run failing — which is the whole
 * reason this is the DEFAULT path and the YouTube harvest is the one that
 * waits on a cookies file.
 *
 * ## The two postures, same as the video harvest
 *
 * `allowlist` keeps only shows whose title matches the client's own
 * `tiktokClips.sourcePool`; `open` takes the best match in the directory.
 * Both are `licenseConfidence: "unknown"` — a public feed is a distribution
 * channel, not a licence to republish — and both reach the same human gate.
 */

/** What a feed hands over, before any of this tool's own checks. */
export interface PodcastEpisodeCandidate {
  /** The episode's own page when the feed gives one, else the enclosure. Carried into the caption's source credit. */
  sourceUrl: string;
  /** Direct audio URL from the feed's `<enclosure>`. */
  mediaUrl: string;
  title: string;
  showTitle: string;
  /** From `<itunes:duration>`, when the feed declares one. */
  durationSeconds?: number;
  publishedAt?: number;
  /**
   * The enclosure's declared MIME, before anything is fetched.
   *
   * This is how a video episode is spotted while it is still free to prefer
   * one — the ranking reads it, so the download only ever happens for the
   * candidate already chosen.
   */
  enclosureType?: string;
}

export interface PodcastHarvestQuery {
  query: string;
  /** Only consider episodes whose enclosure is a moving picture. See the input schema. */
  requireVideo: boolean;
  /** Show titles the client holds clipping rights to. Honoured under `allowlist`, ignored under `open`. */
  allowedShows: readonly string[];
  discovery: "allowlist" | "open";
  minDurationSeconds: number;
  maxDurationSeconds: number;
}

/** `candidate: null` is "no episode to clip" and becomes `content_fail`; a provider that BROKE throws and becomes `tooling_error`. */
export type PodcastHarvestFind =
  | { candidate: PodcastEpisodeCandidate; alternates?: readonly PodcastEpisodeCandidate[] }
  | { candidate: null; reason: string };

export interface PodcastHarvestProvider {
  name: string;
  findEpisode(query: PodcastHarvestQuery): Promise<PodcastHarvestFind>;
}

export const HarvestPodcastInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Absolute path the downloaded audio is written under, inside the run's media cache."),
  runId: z.string().min(1).describe("This run's id — the cache directory is per run, so two runs never read each other's audio."),
  query: z
    .string()
    .min(3)
    .describe("What the episode should be ABOUT. Searched against Apple's podcast directory, so it reads like a subject a show would cover, not like a video title."),
  allowedShows: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Show titles the client holds clipping rights to (their `tiktokClips.sourcePool`). Under `discovery: \"allowlist\"` only episodes from these shows are considered, and with none the tool refuses. Ignored under `discovery: \"open\"`.",
    ),
  discovery: z
    .enum(["allowlist", "open"])
    .default("allowlist")
    .describe(
      "How to find an episode. `allowlist` (default) keeps only the client's own shows and refuses with none; `open` takes the best match in the whole directory. Either way the clip is `licenseConfidence: \"unknown\"` and a human approves it before anything ships.",
    ),
  minDurationSeconds: z.number().int().positive().default(90).describe("Below this an episode is a trailer, not a conversation with a clippable moment in it."),
  maxDurationSeconds: z.number().int().positive().default(10_800).describe("Above this the transcription bill outgrows the clip. Three hours."),
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(500 * 1024 * 1024)
    .describe("Refused above this rather than truncated — a half-downloaded episode transcribes into a moment that ends mid-sentence."),
  requireVideo: z
    .boolean()
    .default(false)
    .describe(
      "True takes ONLY episodes the show publishes on camera, and reports content_fail when it has none — for a caller that can use a video episode and cannot yet use an audio one. False (default) prefers video and accepts audio.",
    ),
});

export type HarvestPodcastInput = z.infer<typeof HarvestPodcastInputSchema>;

export interface HarvestPodcastResult {
  /** Repo-relative, forward-slashed. */
  path: string;
  sourceUrl: string;
  title: string;
  /** The show, which is what the caption credits. */
  showTitle: string;
  durationSeconds?: number;
  provider: string;
  discovery: "allowlist" | "open";
  /**
   * What actually came back, from the response's own content type.
   *
   * `"video"` is the speakers on camera — the thing worth having, and the
   * reason this tool prefers a video enclosure over an audio one. `"audio"`
   * means the clip will carry their words over sourced footage instead.
   * Read from the RESPONSE and not from the feed's declared type, because a
   * feed that says `video/mp4` and serves an MP3 has served an MP3.
   */
  media: "video" | "audio";
}

/** What a podcast feed actually serves, and which of the two kinds it is. Refused, never guessed: a feed that hands back HTML has not handed back an episode. */
const ACCEPTED_ENCLOSURE: Record<string, { extension: string; media: "video" | "audio" }> = {
  "audio/mpeg": { extension: ".mp3", media: "audio" },
  "audio/mp3": { extension: ".mp3", media: "audio" },
  "audio/mp4": { extension: ".m4a", media: "audio" },
  "audio/x-m4a": { extension: ".m4a", media: "audio" },
  "audio/aac": { extension: ".aac", media: "audio" },
  "audio/ogg": { extension: ".ogg", media: "audio" },
  "audio/wav": { extension: ".wav", media: "audio" },
  "audio/x-wav": { extension: ".wav", media: "audio" },
  // The ones worth having: the speakers, on camera, from the show's own feed.
  "video/mp4": { extension: ".mp4", media: "video" },
  "video/quicktime": { extension: ".mov", media: "video" },
  "video/x-m4v": { extension: ".m4v", media: "video" },
  "video/webm": { extension: ".webm", media: "video" },
};

/** Whether a feed's declared enclosure type is a moving picture. Used for RANKING only; what actually arrived decides `media`. */
export function enclosureIsVideo(type: string | undefined): boolean {
  return typeof type === "string" && /^video\//i.test(type.trim());
}

const OUTPUT_STEM = "podcast-episode";

/** `1:02:33`, `62:33` and `3753` are all shapes `<itunes:duration>` takes in the wild. */
export function parseItunesDuration(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text.length === 0) return undefined;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return seconds > 0 ? seconds : undefined;
  }
  const parts = text.split(":").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return undefined;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return undefined;
}

/** Lowercased word set, for the same overlap scoring the video harvest uses. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/**
 * Whether this episode is from a show the client named.
 *
 * Substring both ways, case-folded: a `sourcePool` says "Lenny's Podcast" and
 * a directory says "Lenny's Podcast | Product | Growth | Career". Neither is
 * wrong and neither contains the other in one direction only.
 */
function showIsAllowed(showTitle: string, allowed: readonly string[]): boolean {
  const show = showTitle.toLowerCase();
  return allowed.some((name) => {
    const wanted = name.trim().toLowerCase();
    return wanted.length > 0 && (show.includes(wanted) || wanted.includes(show));
  });
}

interface FeedItem {
  title?: unknown;
  link?: unknown;
  pubDate?: unknown;
  enclosure?: unknown;
  "itunes:duration"?: unknown;
}

/**
 * The episodes of one feed, in the shape this tool scores.
 *
 * Exported for its own tests: RSS in the wild is messy enough (CDATA titles,
 * a single `<item>` that parses as an object rather than an array, an
 * `<enclosure>` with no type) that the parsing deserves testing without a
 * network.
 */
export function readFeedEpisodes(xml: string, showTitleFallback: string): PodcastEpisodeCandidate[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return [];
  }
  const channel = (parsed as { rss?: { channel?: unknown } })?.rss?.channel;
  if (typeof channel !== "object" || channel === null) return [];
  const chan = channel as { title?: unknown; item?: unknown };
  const showTitle = typeof chan.title === "string" && chan.title.trim().length > 0 ? chan.title.trim() : showTitleFallback;
  // A feed with exactly one episode parses `item` as an object, not an array.
  const rawItems = Array.isArray(chan.item) ? chan.item : chan.item !== undefined ? [chan.item] : [];

  const episodes: PodcastEpisodeCandidate[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as FeedItem;
    const enclosure = Array.isArray(item.enclosure) ? item.enclosure[0] : item.enclosure;
    if (typeof enclosure !== "object" || enclosure === null) continue;
    const mediaUrl = (enclosure as Record<string, unknown>)["@_url"];
    if (typeof mediaUrl !== "string" || !/^https?:\/\//i.test(mediaUrl)) continue;
    const enclosureType = (enclosure as Record<string, unknown>)["@_type"];
    const title = typeof item.title === "string" ? item.title.trim() : typeof item.title === "number" ? String(item.title) : "";
    if (title.length === 0) continue;
    const link = typeof item.link === "string" && /^https?:\/\//i.test(item.link) ? item.link : undefined;
    const published = typeof item.pubDate === "string" ? Date.parse(item.pubDate) : NaN;
    episodes.push({
      sourceUrl: link ?? mediaUrl,
      mediaUrl,
      title,
      showTitle,
      ...(parseItunesDuration(item["itunes:duration"]) !== undefined ? { durationSeconds: parseItunesDuration(item["itunes:duration"])! } : {}),
      ...(Number.isFinite(published) ? { publishedAt: published } : {}),
      ...(typeof enclosureType === "string" && enclosureType.trim().length > 0 ? { enclosureType: enclosureType.trim() } : {}),
    });
  }
  return episodes;
}

interface ItunesShow {
  collectionName: string;
  feedUrl: string;
}

/** Apple's keyless podcast search. Exported so the provider's own tests can drive it without a network. */
export function readItunesShows(payload: unknown): ItunesShow[] {
  if (typeof payload !== "object" || payload === null) return [];
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((r): ItunesShow[] => {
    if (typeof r !== "object" || r === null) return [];
    const row = r as Record<string, unknown>;
    const collectionName = typeof row["collectionName"] === "string" ? row["collectionName"].trim() : "";
    const feedUrl = typeof row["feedUrl"] === "string" ? row["feedUrl"] : "";
    if (collectionName.length === 0 || !/^https?:\/\//i.test(feedUrl)) return [];
    return [{ collectionName, feedUrl }];
  });
}

const ITUNES_SEARCH = "https://itunes.apple.com/search";
/** How many shows to open feeds for. Each is one HTTP fetch of a few hundred KB. */
const MAX_FEEDS = 4;
/** How many episodes to hand the tool as retry candidates when the best one will not download. */
const MAX_ALTERNATES = 3;

/**
 * The real backend: Apple's directory for the show, the show's own feed for
 * the episode.
 *
 * `fetchImpl` is injected so the tests drive the whole path — search JSON,
 * feed XML and the audio download — without a network.
 */
export function createItunesPodcastProvider(options: { fetchImpl?: typeof fetch } = {}): PodcastHarvestProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: "itunes-rss",
    async findEpisode(q: PodcastHarvestQuery): Promise<PodcastHarvestFind> {
      if (q.discovery === "allowlist" && q.allowedShows.length === 0) {
        return { candidate: null, reason: "allowlist discovery with no shows on the client's sourcePool — nothing to search within" };
      }
      // Under `allowlist` the SHOW is the query: the pool names what may be
      // clipped, and asking the directory for the topic instead would return
      // shows the client has no rights to and then discard all of them.
      const terms = q.discovery === "allowlist" ? q.allowedShows.slice(0, MAX_FEEDS) : [q.query];
      const shows: ItunesShow[] = [];
      for (const term of terms) {
        const url = `${ITUNES_SEARCH}?media=podcast&entity=podcast&limit=${MAX_FEEDS}&term=${encodeURIComponent(term)}`;
        const response = await fetchImpl(url);
        if (!response.ok) throw new Error(`itunes search for "${term}" returned ${response.status}`);
        shows.push(...readItunesShows(await response.json()));
      }
      const scoped = q.discovery === "allowlist" ? shows.filter((s) => showIsAllowed(s.collectionName, q.allowedShows)) : shows;
      if (scoped.length === 0) {
        return {
          candidate: null,
          reason:
            q.discovery === "allowlist"
              ? `no show in Apple's directory matched ${q.allowedShows.map((s) => `"${s}"`).join(", ")}`
              : `Apple's directory returned no podcast for "${q.query}"`,
        };
      }

      const queryTokens = tokens(q.query);
      const episodes: PodcastEpisodeCandidate[] = [];
      const feedNotes: string[] = [];
      for (const show of scoped.slice(0, MAX_FEEDS)) {
        let xml: string;
        try {
          const response = await fetchImpl(show.feedUrl);
          if (!response.ok) {
            feedNotes.push(`${show.collectionName}: feed returned ${response.status}`);
            continue;
          }
          xml = await response.text();
        } catch (error) {
          // ONE bad feed is not a failed search. A show that moved host, or
          // whose certificate expired, must not cost the other three.
          feedNotes.push(`${show.collectionName}: feed could not be read (${(error as Error).message})`);
          continue;
        }
        episodes.push(...readFeedEpisodes(xml, show.collectionName));
      }

      // A feed that declares no duration is KEPT, unlike the video harvest's
      // bounds check. A YouTube entry with no duration cannot be proven not
      // to be a Short; a podcast episode is a podcast episode, and the worst
      // case is the tool's own byte cap refusing an enormous file.
      const inBounds = episodes.filter((e) => e.durationSeconds === undefined || (e.durationSeconds >= q.minDurationSeconds && e.durationSeconds <= q.maxDurationSeconds));
      if (inBounds.length === 0) {
        const why = episodes.length === 0 ? "no feed yielded a usable episode" : `all ${episodes.length} episode(s) sit outside ${q.minDurationSeconds}-${q.maxDurationSeconds}s`;
        return { candidate: null, reason: `${why}${feedNotes.length > 0 ? ` (${feedNotes.join("; ")})` : ""}` };
      }

      // `requireVideo`: the caller can only use a picture, so an audio
      // episode is not a worse candidate, it is not a candidate. Filtered
      // BEFORE the ranking, so the reason names the real shortage.
      const usable = q.requireVideo ? inBounds.filter((e) => enclosureIsVideo(e.enclosureType)) : inBounds;
      if (usable.length === 0) {
        return {
          candidate: null,
          reason: `no episode is published on camera (${inBounds.length} audio-only episode(s) found)${feedNotes.length > 0 ? ` (${feedNotes.join("; ")})` : ""}`,
        };
      }

      // Nearest on topic, newest as the tie-break — the same ranking the
      // video harvest uses, so the two tiers cannot disagree about what
      // "best" means.
      const rank = (list: readonly PodcastEpisodeCandidate[]): PodcastEpisodeCandidate[] =>
        list
          .map((episode) => {
            const titleTokens = tokens(episode.title);
            let overlap = 0;
            for (const token of queryTokens) if (titleTokens.has(token)) overlap += 1;
            return { episode, overlap, published: episode.publishedAt ?? 0 };
          })
          .sort((a, b) => b.overlap - a.overlap || b.published - a.published)
          .map((r) => r.episode);

      /**
       * VIDEO FIRST, when a video episode is on topic at all.
       *
       * Seeing the podcast — the speakers, on camera — is the point of a
       * podcast clip, and a show that publishes a video enclosure hands that
       * over with no bot check in the way. So video candidates are ranked as
       * their own pool and lead.
       *
       * The guard is `overlap > 0`: preferring video unconditionally would
       * ship an off-topic video episode over an audio one that is exactly
       * right, and a clip about the wrong thing is not improved by being able
       * to see who said it. With no video episode on topic, audio leads and
       * the video candidates stay as alternates — a link that will not
       * download is a link that will not download whichever pool it came
       * from.
       */
      const onTopic = (episode: PodcastEpisodeCandidate): boolean => {
        const titleTokens = tokens(episode.title);
        for (const token of queryTokens) if (titleTokens.has(token)) return true;
        return false;
      };
      const videoRanked = rank(usable.filter((e) => enclosureIsVideo(e.enclosureType)));
      const audioRanked = rank(usable.filter((e) => !enclosureIsVideo(e.enclosureType)));
      const videoLeads = videoRanked.length > 0 && onTopic(videoRanked[0]!);
      const ranked = videoLeads ? [...videoRanked, ...audioRanked] : [...audioRanked, ...videoRanked];

      return { candidate: ranked[0]!, alternates: ranked.slice(1, 1 + MAX_ALTERNATES) };
    },
  };
}

/**
 * The tool. Owns every check that matters once a provider names an episode:
 * the response is audio, it is under the cap, it is not empty, and it lands
 * inside this run's own cache directory.
 */
export function createHarvestPodcast(options: { provider?: PodcastHarvestProvider | undefined; fetchImpl?: typeof fetch } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const provider = options.provider;
  return defineTool({
    name: "media.harvestPodcast",
    version: TOOL_VERSION,
    description:
      "Finds a PODCAST EPISODE about a topic in Apple's public directory, reads the show's own RSS feed, and downloads the episode audio into the run cache. Keyless and unauthenticated, because a podcast feed exists to be fetched — unlike a video host, which defends against exactly this. Honours the client's sourcePool under `discovery: \"allowlist\"`. Reports not_available when no provider is configured, so the clip cascade moves on rather than holding.",
    inputSchema: HarvestPodcastInputSchema,
    async execute(input, { ctx: _ctx }) {
      if (provider === undefined) return notAvailable("media.harvestPodcast: no podcast provider is configured");

      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(input.repoRoot, relDir);

      let found: PodcastHarvestFind;
      try {
        found = await provider.findEpisode({
          query: input.query,
          allowedShows: input.allowedShows,
          discovery: input.discovery,
          minDurationSeconds: input.minDurationSeconds,
          maxDurationSeconds: input.maxDurationSeconds,
          requireVideo: input.requireVideo,
        });
      } catch (error) {
        return toolingError(`media.harvestPodcast: provider "${provider.name}" failed to search — ${(error as Error).message}`);
      }
      if (found.candidate === null) return contentFail(`media.harvestPodcast: ${found.reason}`);

      await fs.mkdir(absDir, { recursive: true });
      const ranked: readonly PodcastEpisodeCandidate[] = [found.candidate, ...(found.alternates ?? [])];
      const refusals: string[] = [];

      for (const episode of ranked) {
        let response: Awaited<ReturnType<typeof fetch>>;
        try {
          response = await fetchImpl(episode.mediaUrl);
        } catch (error) {
          refusals.push(`${episode.title}: ${(error as Error).message}`);
          continue;
        }
        if (!response.ok) {
          refusals.push(`${episode.title}: the enclosure returned ${response.status}`);
          continue;
        }
        const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        const accepted = ACCEPTED_ENCLOSURE[mime];
        if (accepted === undefined) {
          // A feed that hands back HTML has handed back a paywall or an
          // interstitial, not an episode. Refused, never guessed.
          refusals.push(`${episode.title}: refused content type "${mime || "(none)"}"`);
          continue;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > input.maxBytes) {
          refusals.push(`${episode.title}: ${bytes.byteLength} bytes (cap ${input.maxBytes})`);
          continue;
        }
        if (input.requireVideo && accepted.media !== "video") {
          // The feed declared a picture and served sound. `requireVideo` is
          // not a preference the caller can absorb — it means the pipeline
          // has nowhere to put an audio file — so this is a refusal, not a
          // downgrade.
          refusals.push(`${episode.title}: the feed declared video and served ${mime}`);
          continue;
        }
        const fileName = `${OUTPUT_STEM}${accepted.extension}`;
        await fs.writeFile(path.join(absDir, fileName), bytes);
        return success<HarvestPodcastResult>({
          path: `${relDir}/${fileName}`,
          sourceUrl: episode.sourceUrl,
          title: episode.title,
          showTitle: episode.showTitle,
          ...(episode.durationSeconds !== undefined ? { durationSeconds: episode.durationSeconds } : {}),
          provider: provider.name,
          discovery: input.discovery,
          // From the RESPONSE, not from the feed's declared type: a feed that
          // says `video/mp4` and serves an MP3 has served an MP3, and the
          // clip pipeline routes on this.
          media: accepted.media,
        });
      }

      return contentFail(`media.harvestPodcast: none of the ${ranked.length} episode(s) could be downloaded — ${refusals.join("; ")}`);
    },
  });
}
