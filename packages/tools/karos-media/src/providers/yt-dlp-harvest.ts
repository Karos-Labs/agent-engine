import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { VideoHarvestCandidate, VideoHarvestFind, VideoHarvestProvider, VideoHarvestQuery } from "../harvest-video.js";
import { createDefaultProcessRunner, type ProcessRunnerLike } from "../process-runner.js";

/**
 * `media.harvestVideo`'s first real backend: `yt-dlp`, rights-restricted.
 *
 * ## Two search postures, and the caller picks
 *
 * The commentary-clip format lives on OTHER people's footage — a podcast
 * segment, a keynote moment — so how it was found is a fact about the clip.
 *
 * `discovery: "allowlist"` is the original, and the default. The search is
 * scoped per allowed source (`ytsearchN:<source> <query>`), every hit is then
 * checked to actually be FROM that source (uploader/channel/title), and a
 * client whose pool names no shows gets a refusal rather than a best-effort
 * web search. "Found something on topic" is not a rights basis; "found it on
 * a channel the client may clip" is.
 *
 * `discovery: "open"` searches the whole of YouTube for the query and takes
 * the best-scoring result on topic. It is the weaker posture and it exists
 * because the owner chose reach on 2026-09-20 —
 * `docs/RFC-25-tiktok-clipping-sources.md` records that decision, the
 * alternatives it was chosen over, and what still protects the client: every
 * clip reaches a human before publication, the caption must credit the
 * source, and the reviewer is told which of these two searches found it.
 *
 * ## Why it downloads itself
 *
 * YouTube serves no directly fetchable media URL — formats are separate
 * signed streams that expire and need merging — so this provider implements
 * the seam's `download` branch (yt-dlp writes the merged mp4 into the run
 * cache dir) rather than the `mediaUrl` branch the fetch-based path expects.
 * The tool still owns every check that matters afterwards: the file exists,
 * sits inside the cache dir, is under `maxBytes`, and carries a video
 * extension.
 */

export interface YtDlpHarvestProviderOptions {
  /** Injectable for tests; production spawns `yt-dlp` via `execFile`. */
  runner?: ProcessRunnerLike;
  /** Path/name of the binary. Falls back to `YT_DLP_BIN`, then `yt-dlp` on the PATH. */
  ytDlpBin?: string;
  env?: Record<string, string | undefined>;
  /** How many search results to pull per allowed source before filtering. Default 8. */
  searchPerSource?: number;
  /** A Netscape cookies file, passed as `--cookies`. Falls back to `YT_DLP_COOKIES_FILE`. Needed for age-gated or member-only shows. */
  cookiesFile?: string;
}

/** The subset of a `--flat-playlist --dump-single-json` entry this provider reads. Everything is optional because yt-dlp's flat extraction fills in what it can. */
export interface YtDlpFlatEntry {
  id?: string;
  url?: string;
  webpage_url?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number | null;
  /** `YYYYMMDD` */
  upload_date?: string;
  timestamp?: number;
  release_timestamp?: number;
}

/**
 * Best mp4 video up to 1080p plus m4a audio, merged; falls back to a
 * pre-muxed mp4, then to whatever is best. 1080p is the ceiling because the
 * pipeline re-encodes to a 1080x1920 canvas anyway — a 4K source costs
 * minutes of download and nothing on screen.
 */
export const YT_DLP_DOWNLOAD_FORMAT = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b";

const OUTPUT_STEM = "harvested-clip";

/** Lower-case, letters and digits only, single-spaced — so "The Diary Of A CEO" matches "diary of a ceo" and "DiaryOfACEO Clips". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((token) => token.length >= 2),
  );
}

function entryIsFromSource(entry: YtDlpFlatEntry, source: string): boolean {
  const needle = normalize(source).replace(/ /g, "");
  if (needle.length === 0) return false;
  return [entry.uploader, entry.channel, entry.title].some(
    (field) => typeof field === "string" && normalize(field).replace(/ /g, "").includes(needle),
  );
}

/** Newest-first tiebreak. Flat entries rarely carry a date, so 0 (unknown) is common and ranks last. */
function publishedAt(entry: YtDlpFlatEntry): number {
  if (typeof entry.release_timestamp === "number") return entry.release_timestamp;
  if (typeof entry.timestamp === "number") return entry.timestamp;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(entry.upload_date ?? "");
  if (match) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000;
  return 0;
}

function watchUrl(entry: YtDlpFlatEntry): string | undefined {
  const candidate = entry.webpage_url ?? entry.url;
  if (candidate && /^https?:\/\//i.test(candidate)) return candidate;
  if (entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  return undefined;
}

function tail(text: string, chars = 600): string {
  return text.trim().slice(-chars);
}

export function createYtDlpHarvestProvider(options: YtDlpHarvestProviderOptions = {}): VideoHarvestProvider {
  const env = options.env ?? {};
  const runner = options.runner ?? createDefaultProcessRunner();
  const ytDlpBin = options.ytDlpBin ?? env["YT_DLP_BIN"]?.trim() ?? "yt-dlp";
  // The real answer to YouTube's bot challenge, and the only one that is not
  // an arms race: a cookies.txt export from a signed-in session, mounted as a
  // file. Absent, the player-client ladder in `downloadInto` is the fallback.
  const cookiesFile = options.cookiesFile ?? env["YT_DLP_COOKIES_FILE"]?.trim();
  const searchPerSource = options.searchPerSource ?? 8;
  const cookieArgs = cookiesFile ? ["--cookies", cookiesFile] : [];

  /**
   * The clients yt-dlp can impersonate, tried in order until one is served.
   *
   * YouTube's "Sign in to confirm you're not a bot" is issued per CLIENT, not
   * only per IP: the default web client is the one it challenges hardest, and
   * the TV and mobile players are routinely served where it is not. This is
   * an arms race and none of these is guaranteed — which is why
   * `YT_DLP_COOKIES_FILE` remains the real answer and the clip cascade still
   * has a tier below this one.
   *
   * `undefined` first: the default client is the highest-quality path and
   * costs nothing when it works. The alternates only run after a challenge,
   * so a healthy deployment never pays for them.
   */
  const PLAYER_CLIENTS: ReadonlyArray<string | undefined> = [undefined, "tv", "android_vr", "web_safari"];

  /** YouTube's bot challenge, as it appears on stderr. Matched loosely: the wording has changed twice and the apostrophe is a curly one. */
  function isBotChallenge(text: string): boolean {
    return /confirm\s+you.{0,3}re\s+not\s+a\s+bot|sign in to confirm/i.test(text);
  }

  async function downloadInto(url: string, destDirAbs: string, maxBytes: number): Promise<{ path: string }> {
    let lastError = "";
    for (const client of PLAYER_CLIENTS) {
      // A previous attempt in the same run dir (another candidate, or the
      // previous player client) may have left `harvested-clip.*` behind;
      // yt-dlp would report "already downloaded" and exit 0, and the tool
      // would then read the WRONG file.
      for (const stale of await existingOutputs(destDirAbs)) {
        await fs.rm(path.join(destDirAbs, stale), { force: true });
      }

      const result = await runner(ytDlpBin, [
        url,
        "-f",
        YT_DLP_DOWNLOAD_FORMAT,
        "--merge-output-format",
        "mp4",
        "--max-filesize",
        String(maxBytes),
        "--no-playlist",
        "--no-warnings",
        "-o",
        path.join(destDirAbs, `${OUTPUT_STEM}.%(ext)s`),
        ...(client !== undefined ? ["--extractor-args", `youtube:player_client=${client}`] : []),
        ...cookieArgs,
      ]);
      if (result.exitCode === 0) break;

      lastError = tail(result.stderr || result.stdout) || "(no output)";
      // Only a bot challenge is worth another client. A private video, a
      // removed one or a geo-block answers the same way whoever asks, and
      // retrying three more times would cost three more yt-dlp invocations
      // to learn nothing.
      if (!isBotChallenge(lastError) || client === PLAYER_CLIENTS[PLAYER_CLIENTS.length - 1]) {
        throw new Error(`yt-dlp exited ${result.exitCode} downloading ${url}: ${lastError}`);
      }
    }

    // `--max-filesize` is a SKIP, not an error: yt-dlp prints a notice and
    // exits 0 having written nothing. Resolving the real file, rather than
    // trusting the template, is what catches that.
    const written = (await existingOutputs(destDirAbs)).filter((name) => !/\.(part|ytdl)$/i.test(name));
    const preferred = written.find((name) => name.endsWith(".mp4")) ?? written.find((name) => name.endsWith(".webm")) ?? written[0];
    if (preferred === undefined) {
      throw new Error(`yt-dlp exited 0 for ${url} but wrote no ${OUTPUT_STEM}.* file — most likely the source exceeds --max-filesize ${maxBytes}`);
    }
    return { path: path.join(destDirAbs, preferred) };
  }

  async function existingOutputs(dir: string): Promise<string[]> {
    try {
      return (await fs.readdir(dir)).filter((name) => name.startsWith(`${OUTPUT_STEM}.`));
    } catch {
      return [];
    }
  }

  return {
    name: "yt-dlp",
    /**
     * One page, no search (RFC-25 phase 4).
     *
     * `--dump-single-json` on a watch URL returns that video's metadata, which
     * is how the duration bounds still apply to a page somebody chose by hand:
     * a three-hour stream is a download the run cannot afford however it was
     * picked, and finding that out before the download is the whole point of
     * asking first.
     */
    async resolveUrl(sourceUrl, q): Promise<VideoHarvestFind> {
      const probe = await runner(ytDlpBin, [sourceUrl, "--dump-single-json", "--no-warnings", "--skip-download", ...cookieArgs]);
      if (probe.exitCode !== 0) {
        throw new Error(`yt-dlp could not read ${sourceUrl}: exited ${probe.exitCode} (${tail(probe.stderr || probe.stdout, 300) || "no output"})`);
      }
      let meta: YtDlpFlatEntry;
      try {
        meta = JSON.parse(probe.stdout) as YtDlpFlatEntry;
      } catch {
        throw new Error(`yt-dlp's metadata for ${sourceUrl} was not JSON`);
      }
      const duration = typeof meta.duration === "number" ? meta.duration : undefined;
      // A page that resolves to nothing clippable is a CONTENT outcome, not a
      // broken tool: the paste worked, the video is just not one this pipeline
      // can use, and the caller needs to tell those two apart.
      if (duration === undefined) {
        return { candidate: null, reason: `${sourceUrl} reports no duration — it may be a live stream or a playlist rather than an episode` };
      }
      if (duration < q.minDurationSeconds || duration > q.maxDurationSeconds) {
        return {
          candidate: null,
          reason: `${sourceUrl} is ${Math.round(duration)}s, outside the ${q.minDurationSeconds}-${q.maxDurationSeconds}s a clip can be cut from`,
        };
      }
      const channel = meta.channel ?? meta.uploader;
      return {
        candidate: {
          sourceUrl,
          ...(meta.title !== undefined ? { title: meta.title } : {}),
          ...(channel !== undefined ? { channel } : {}),
          durationSeconds: duration,
          download: (destDirAbs) => downloadInto(sourceUrl, destDirAbs, q.maxBytes),
        },
      };
    },

    async findVideo(q: VideoHarvestQuery): Promise<VideoHarvestFind> {
      if (q.discovery === "allowlist" && q.allowedSources.length === 0) {
        return {
          candidate: null,
          reason: "no allowed sources: the client's sourcePool names no shows, and an allowlist search never searches the open web unrestricted",
        };
      }

      const queryTokens = tokens(q.query);
      const perSource: string[] = [];
      const broken: string[] = [];

      /**
       * Scores usable entries the way both postures do and returns EVERY one
       * as a candidate: nearest on topic first, newest as the tie-break.
       *
       * It used to return only the winner, so a search that found twelve
       * clippable podcasts gave up when the best one would not download — and
       * "would not download" covers private, removed, geo-blocked,
       * members-only, and YouTube's bot check, none of which say anything
       * about whether the query found something worth clipping.
       */
      const rank = (usable: readonly YtDlpFlatEntry[]): VideoHarvestCandidate[] => {
        const scored = usable
          .map((entry) => {
            const titleTokens = tokens(entry.title ?? "");
            let overlap = 0;
            for (const token of queryTokens) if (titleTokens.has(token)) overlap += 1;
            return { entry, overlap, published: publishedAt(entry) };
          })
          .sort((a, b) => b.overlap - a.overlap || b.published - a.published);
        return scored.map(({ entry }) => {
          const sourceUrl = watchUrl(entry)!;
          const channel = entry.channel ?? entry.uploader;
          return {
            sourceUrl,
            ...(entry.title !== undefined ? { title: entry.title } : {}),
            ...(channel !== undefined ? { channel } : {}),
            ...(typeof entry.duration === "number" ? { durationSeconds: entry.duration } : {}),
            download: (destDirAbs: string) => downloadInto(sourceUrl, destDirAbs, q.maxBytes),
          };
        });
      };

      /**
       * How many failures to absorb before giving up on a search.
       *
       * Each retry is another yt-dlp invocation, a few seconds each. Four
       * attempts covers the scattered causes (this one is private, that one
       * is geo-blocked) without turning a fully blocked worker into a minute
       * of pointless retries — a bot check is IP-wide, so when it is THAT,
       * all four fail and the clip cascade's next tier is the real answer.
       */
      const MAX_ATTEMPTS = 4;
      const find = (usable: readonly YtDlpFlatEntry[]): VideoHarvestFind => {
        const ranked = rank(usable);
        return { candidate: ranked[0]!, alternates: ranked.slice(1, MAX_ATTEMPTS) };
      };

      /** The checks that are about the VIDEO rather than about its source: a clippable length, and an address to fetch it from. */
      const withinBounds = (entry: YtDlpFlatEntry): boolean => {
        // An entry with no duration cannot be proven not to be a Short, so it
        // is treated as out of bounds rather than guessed at.
        const duration = typeof entry.duration === "number" ? entry.duration : undefined;
        if (duration === undefined || duration < q.minDurationSeconds || duration > q.maxDurationSeconds) return false;
        return watchUrl(entry) !== undefined;
      };

      // ── The open search: one query, the whole provider, best on topic ──
      //
      // `searchPerSource * 4` rather than `searchPerSource`: the allowlist
      // path gets that many results PER show and takes the first show that
      // answers, so a handful each is plenty. Here one search carries the
      // whole run, and the duration filter alone discards most of a YouTube
      // result page (Shorts, clips, trailers).
      if (q.discovery === "open") {
        const result = await runner(ytDlpBin, [
          `ytsearch${searchPerSource * 4}:${q.query}`,
          "--dump-single-json",
          "--flat-playlist",
          "--no-warnings",
          "--skip-download",
          ...cookieArgs,
        ]);
        if (result.exitCode !== 0) {
          throw new Error(`yt-dlp open search exited ${result.exitCode} (${tail(result.stderr || result.stdout, 300) || "no output"})`);
        }
        let entries: YtDlpFlatEntry[];
        try {
          const parsed = JSON.parse(result.stdout) as { entries?: unknown };
          entries = Array.isArray(parsed.entries) ? (parsed.entries as YtDlpFlatEntry[]) : [];
        } catch {
          throw new Error("yt-dlp's open search output was not JSON");
        }
        const usable = entries.filter(withinBounds);
        if (usable.length === 0) {
          return {
            candidate: null,
            reason: `open search found no video for "${q.query}" inside ${q.minDurationSeconds}-${q.maxDurationSeconds}s (${entries.length} result(s) before filtering)`,
          };
        }
        return find(usable);
      }

      for (const source of q.allowedSources) {
        const result = await runner(ytDlpBin, [
          `ytsearch${searchPerSource}:${source} ${q.query}`,
          "--dump-single-json",
          "--flat-playlist",
          "--no-warnings",
          "--skip-download",
          ...cookieArgs,
        ]);
        if (result.exitCode !== 0) {
          broken.push(`${source}: yt-dlp exited ${result.exitCode} (${tail(result.stderr || result.stdout, 300) || "no output"})`);
          continue;
        }

        let entries: YtDlpFlatEntry[];
        try {
          const parsed = JSON.parse(result.stdout) as { entries?: unknown };
          entries = Array.isArray(parsed.entries) ? (parsed.entries as YtDlpFlatEntry[]) : [];
        } catch {
          broken.push(`${source}: yt-dlp's search output was not JSON`);
          continue;
        }

        let otherChannel = 0;
        let outsideBounds = 0;
        const usable = entries.filter((entry) => {
          if (!entryIsFromSource(entry, source)) {
            otherChannel += 1;
            return false;
          }
          if (!withinBounds(entry)) {
            outsideBounds += 1;
            return false;
          }
          return true;
        });

        if (usable.length === 0) {
          perSource.push(
            `${source}: ${entries.length} result(s), ${otherChannel} from another channel, ${outsideBounds} outside ${q.minDurationSeconds}–${q.maxDurationSeconds}s`,
          );
          continue;
        }

        return find(usable);
      }

      // Every source answered and none had a usable episode: a real "nothing
      // to clip" outcome. But a source whose SEARCH broke was never really
      // asked, and that is a tooling problem the cascade should not mistake
      // for an editorial one.
      if (broken.length > 0) {
        throw new Error(`yt-dlp search failed for ${broken.length} of ${q.allowedSources.length} source(s): ${broken.join("; ")}`);
      }
      return {
        candidate: null,
        reason: `no allowed source yielded a usable video for "${q.query}" — ${perSource.join("; ")}`,
      };
    },
  };
}
