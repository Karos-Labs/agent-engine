import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, parseDurationMs, success, toolingError } from "@agent-engine/tool-common";
import { latestRunForQuery, writeRunRecord, type RunRecord } from "./runs.js";

const TOOL_VERSION = "1.0.0";
const JOB = "entity-lookup";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const USER_AGENT = "KarosAuditBot/1.0 (https://karoslabs.com; hello@karoslabs.com)";

export const LookupEntityInputSchema = z.object({
  brandName: z.string().min(1).describe("The brand as a person writes it — the label searched on Wikidata."),
  aliases: z.array(z.string().min(1)).max(8).default([]).describe("Other spellings (a Hebrew or transliterated name), each searched too."),
  clientDomains: z.array(z.string().min(1)).min(1).describe("The client's own domains. A Wikidata item whose official website (P856) is one of these is the match; nothing else is accepted as this client."),
  preferredLanguages: z.array(z.string().min(2).max(8)).max(4).default(["en"]).describe("Wikipedia languages to try first for the article check (e.g. [\"he\", \"en\"])."),
  window: z.string().min(1).default("7d").describe("Freshness window — a lookup of the same brand inside it is returned instead of re-querying."),
});
export type LookupEntityInput = z.input<typeof LookupEntityInputSchema>;

export interface EntitySnapshot {
  brandName: string;
  fetchedAt: string;
  /** How the item was accepted: its P856 official-website matches a client domain (the only accepted match), or nothing matched. */
  match: "official-website" | "none";
  wikidata?: {
    qid: string;
    label?: string;
    description?: string;
    officialWebsite?: string;
    officialWebsiteMatchesClient: boolean;
    /** Claims carrying at least one reference — GEO-25's ">=5 referenced statements" leg. */
    referencedStatementCount: number;
    statementCount: number;
    /** Wikipedia language editions with an article, e.g. ["en", "he"]. */
    wikipediaLanguages: string[];
    /** Candidate items considered and why the top one was rejected, for the audit trail. */
    candidatesConsidered: number;
  };
  wikipedia?: {
    language: string;
    title: string;
    /** Characters in the article's intro extract. */
    extractLength: number;
    /** Intro shorter than `STUB_EXTRACT_CHARS` reads as a stub. */
    nonStub: boolean;
    url?: string;
  };
}

export interface LookupEntityResult {
  runId: string;
  snapshot: EntitySnapshot;
  fromCache: boolean;
  ageMs: number;
}

export interface EntityLookupToolOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** An intro extract below this many characters is treated as a stub — roughly three sentences. */
export const STUB_EXTRACT_CHARS = 400;

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function sameSite(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}

interface WikidataEntity {
  id: string;
  labels?: Record<string, { value?: string }>;
  descriptions?: Record<string, { value?: string }>;
  claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } }; references?: unknown[] }>>;
  sitelinks?: Record<string, { title?: string; url?: string }>;
}

/** Pure: reads P856 + reference/statement counts + Wikipedia sitelinks off one Wikidata entity. Exported for tests against a recorded entity. */
export function summariseWikidataEntity(entity: WikidataEntity, clientDomains: readonly string[]): NonNullable<EntitySnapshot["wikidata"]> {
  const claims = entity.claims ?? {};
  let statementCount = 0;
  let referencedStatementCount = 0;
  for (const statements of Object.values(claims)) {
    for (const statement of statements) {
      statementCount += 1;
      if (Array.isArray(statement.references) && statement.references.length > 0) referencedStatementCount += 1;
    }
  }
  const officialWebsite = claims["P856"]?.map((s) => s.mainsnak?.datavalue?.value).find((v): v is string => typeof v === "string");
  const officialWebsiteMatchesClient = officialWebsite !== undefined && clientDomains.some((d) => sameSite(hostOf(officialWebsite), hostOf(d)));
  const wikipediaLanguages = Object.keys(entity.sitelinks ?? {})
    .filter((key) => /^[a-z-]+wiki$/.test(key) && !/^(commons|species|data|quote|source|books|news|versity|voyage)wiki$/.test(key))
    .map((key) => key.replace(/wiki$/, ""))
    .sort();
  const label = entity.labels?.["en"]?.value ?? Object.values(entity.labels ?? {})[0]?.value;
  const description = entity.descriptions?.["en"]?.value ?? Object.values(entity.descriptions ?? {})[0]?.value;
  return {
    qid: entity.id,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(officialWebsite ? { officialWebsite } : {}),
    officialWebsiteMatchesClient,
    referencedStatementCount,
    statementCount,
    wikipediaLanguages,
    candidatesConsidered: 0,
  };
}

/**
 * `research.lookupEntity`: does the world's structured knowledge know this
 * brand? Wikidata search by name (and aliases), accepting only an item whose
 * official website (P856) is one of the client's domains — a same-named
 * company elsewhere is never this client — then the item's referenced-
 * statement count and Wikipedia sitelinks, and one Wikipedia intro extract to
 * tell a real article from a stub. Public APIs, no credential, cached per
 * brand inside the window. Feeds GEO-25 / GEO-07 (the `offsite_entity` bucket)
 * from real reads instead of leaving them permanently unavailable.
 */
export function createLookupEntity(store: WorkspaceStoreLike, options: EntityLookupToolOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;

  async function getJson(url: string): Promise<unknown> {
    const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.json();
  }

  return defineTool<LookupEntityInput, LookupEntityResult>({
    name: "research.lookupEntity",
    description:
      "Looks a brand up on Wikidata (by name and aliases), accepting only an item whose official website matches one of the client's domains, and reports its referenced-statement count, Wikipedia language editions and whether the Wikipedia intro is more than a stub. Public APIs, no credential; cached per brand inside the freshness window.",
    version: TOOL_VERSION,
    inputSchema: LookupEntityInputSchema,
    async execute(rawInput, { ctx }) {
      const input = rawInput as z.output<typeof LookupEntityInputSchema>;
      const query = input.brandName;
      const cached = await latestRunForQuery(store, ctx.clientSlug, JOB, query);
      if (cached) {
        const ageMs = Date.now() - cached.at;
        if (ageMs <= parseDurationMs(input.window)) {
          return success<LookupEntityResult>({ runId: cached.runId, snapshot: cached.result as EntitySnapshot, fromCache: true, ageMs });
        }
      }

      const searchTerms = [input.brandName, ...input.aliases].map((t) => t.trim()).filter(Boolean);
      const candidateIds: string[] = [];
      try {
        for (const term of searchTerms.slice(0, 4)) {
          for (const language of ["en", ...input.preferredLanguages.filter((l) => l !== "en")].slice(0, 2)) {
            const params = new URLSearchParams({ action: "wbsearchentities", search: term, language, uselang: "en", type: "item", limit: "6", format: "json", origin: "*" });
            const body = rec(await getJson(`${WIKIDATA_API}?${params.toString()}`));
            for (const hit of Array.isArray(body["search"]) ? body["search"] : []) {
              const id = rec(hit)["id"];
              if (typeof id === "string" && !candidateIds.includes(id)) candidateIds.push(id);
            }
          }
        }
      } catch (error) {
        return toolingError(`research.lookupEntity: Wikidata search failed: ${(error as Error).message}`);
      }

      let snapshot: EntitySnapshot = { brandName: input.brandName, fetchedAt: new Date().toISOString(), match: "none" };
      if (candidateIds.length > 0) {
        let entities: Record<string, WikidataEntity> = {};
        try {
          const params = new URLSearchParams({ action: "wbgetentities", ids: candidateIds.slice(0, 12).join("|"), props: "labels|descriptions|claims|sitelinks", format: "json", origin: "*" });
          entities = rec(rec(await getJson(`${WIKIDATA_API}?${params.toString()}`))["entities"]) as Record<string, WikidataEntity>;
        } catch (error) {
          return toolingError(`research.lookupEntity: Wikidata entity read failed: ${(error as Error).message}`);
        }
        const summaries = candidateIds.map((id) => entities[id]).filter((e): e is WikidataEntity => Boolean(e && e.id)).map((e) => summariseWikidataEntity(e, input.clientDomains));
        const matched = summaries.find((s) => s.officialWebsiteMatchesClient);
        if (matched) {
          snapshot = { ...snapshot, match: "official-website", wikidata: { ...matched, candidatesConsidered: summaries.length } };
          const preferred = [...input.preferredLanguages, "en"].filter((l, i, all) => all.indexOf(l) === i);
          const language = preferred.find((l) => matched.wikipediaLanguages.includes(l)) ?? matched.wikipediaLanguages[0];
          const sitelink = language ? entities[matched.qid]?.sitelinks?.[`${language}wiki`] : undefined;
          if (language && sitelink?.title) {
            try {
              const summary = rec(await getJson(`https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(sitelink.title.replace(/ /g, "_"))}`));
              const extract = typeof summary["extract"] === "string" ? (summary["extract"] as string) : "";
              const pageUrl = rec(rec(summary["content_urls"])["desktop"])["page"];
              snapshot = {
                ...snapshot,
                wikipedia: {
                  language,
                  title: sitelink.title,
                  extractLength: extract.length,
                  nonStub: extract.length >= STUB_EXTRACT_CHARS,
                  ...(typeof pageUrl === "string" ? { url: pageUrl } : {}),
                },
              };
            } catch {
              // The article check is best-effort: a Wikipedia read failing leaves the Wikidata half standing.
            }
          }
        }
      }

      const runId = randomUUID();
      const record: RunRecord = { job: JOB, runId, query, result: snapshot, at: Date.now() };
      await writeRunRecord(store, ctx.clientSlug, record);
      return success<LookupEntityResult>({ runId, snapshot, fromCache: false, ageMs: 0 });
    },
  });
}
