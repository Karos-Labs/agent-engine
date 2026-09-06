import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { VideoHarvestCandidate, VideoHarvestFind, VideoHarvestProvider, VideoHarvestQuery } from "../harvest-video.js";
import { createDefaultProcessRunner, type ProcessRunnerLike } from "../process-runner.js";

/**
 * `media.harvestVideo`'s first real backend: `yt-dlp`, rights-restricted.
 *
 * ## Why it never searches the open web
 *
 * The commentary-clip format lives on OTHER people's footage — a podcast
 * segment, a keynote moment — and the only thing that makes publishing it
 * defensible is that the client holds clipping rights to that specific show
 * (their `tiktokClips.sourcePool`). So the search is scoped per allowed
 * source (`ytsearchN:<source> <query>`), every hit is then checked to
 * actually be FROM that source (uploader/channel/title), and a client whose
 * pool names no shows gets a refusal rather than a best-effort web search.
 * "Found something on topic" is not a rights basis; "found it on a channel
 * the client may clip" is.
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
  const cookiesFile = options.cookiesFile ?? env["YT_DLP_COOKIES_FILE"]?.trim();
  const searchPerSource = options.searchPerSource ?? 8;
  const cookieArgs = cookiesFile ? ["--cookies", cookiesFile] : [];

  async function downloadInto(url: string, destDirAbs: string, maxBytes: number): Promise<{ path: string }> {
    // A previous attempt in the same run dir (a retry, a different candidate)
    // may have left `harvested-clip.*` behind; yt-dlp would report "already
    // downloaded" and exit 0, and the tool would then read the WRONG file.
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
      ...cookieArgs,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`yt-dlp exited ${result.exitCode} downloading ${url}: ${tail(result.stderr || result.stdout) || "(no output)"}`);
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
    async findVideo(q: VideoHarvestQuery): Promise<VideoHarvestFind> {
      if (q.allowedSources.length === 0) {
        return {
          candidate: null,
          reason: "no allowed sources: the client's sourcePool names no shows, and this provider never searches the open web unrestricted",
        };
      }

      const queryTokens = tokens(q.query);
      const perSource: string[] = [];
      const broken: string[] = [];

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
          // An entry with no duration cannot be proven not to be a Short, so it is treated as out of bounds rather than guessed at.
          const duration = typeof entry.duration === "number" ? entry.duration : undefined;
          if (duration === undefined || duration < q.minDurationSeconds || duration > q.maxDurationSeconds) {
            outsideBounds += 1;
            return false;
          }
          return watchUrl(entry) !== undefined;
        });

        if (usable.length === 0) {
          perSource.push(
            `${source}: ${entries.length} result(s), ${otherChannel} from another channel, ${outsideBounds} outside ${q.minDurationSeconds}–${q.maxDurationSeconds}s`,
          );
          continue;
        }

        const scored = usable
          .map((entry) => {
            const titleTokens = tokens(entry.title ?? "");
            let overlap = 0;
            for (const token of queryTokens) if (titleTokens.has(token)) overlap += 1;
            return { entry, overlap, published: publishedAt(entry) };
          })
          .sort((a, b) => b.overlap - a.overlap || b.published - a.published);

        const best = scored[0]!.entry;
        const sourceUrl = watchUrl(best)!;
        const channel = best.channel ?? best.uploader;
        const candidate: VideoHarvestCandidate = {
          sourceUrl,
          ...(best.title !== undefined ? { title: best.title } : {}),
          ...(channel !== undefined ? { channel } : {}),
          ...(typeof best.duration === "number" ? { durationSeconds: best.duration } : {}),
          download: (destDirAbs) => downloadInto(sourceUrl, destDirAbs, q.maxBytes),
        };
        return { candidate };
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
