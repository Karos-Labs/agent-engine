import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, parseDurationMs, success, toolingError } from "@agent-engine/tool-common";
import { latestRunForQuery, writeRunRecord, type RunRecord } from "./runs.js";

// 1.0.0 — new (2026-09-23): the people a company is recognised by.
const TOOL_VERSION = "1.0.0";
const JOB = "entity-people";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const USER_AGENT = "KarosAuditBot/1.0 (https://karoslabs.com; hello@karoslabs.com)";

/** Wikidata properties, named once. */
const P = {
  instanceOf: "P31",
  officialWebsite: "P856",
  ceo: "P169",
  foundedBy: "P112",
  chairperson: "P488",
  developer: "P178",
  manufacturer: "P176",
  endTime: "P582",
  human: "Q5",
} as const;

/** Two faces at most: a carousel names a company's leader, rarely its whole board. */
const MAX_PEOPLE = 2;

export const EntityPeopleInputSchema = z.object({
  name: z.string().min(1).max(80).describe("The company or product as the evidence writes it, e.g. \"OpenAI\" or \"ChatGPT\"."),
  kind: z.enum(["company", "product"]).describe("A product is followed one hop to the company that develops or makes it."),
  officialDomain: z
    .string()
    .max(120)
    .optional()
    .describe("The entity's own site when a fact card cited it. A Wikidata item whose official website matches it wins over a same-named one."),
  window: z.string().min(1).default("30d").describe("Freshness window. Who runs a company changes slowly."),
});
export type EntityPeopleInput = z.input<typeof EntityPeopleInputSchema>;

export interface EntityPerson {
  name: string;
  role: "ceo" | "founder" | "chairperson";
  qid: string;
}

export interface EntityPeopleResult {
  runId: string;
  /** The company the people belong to, when one was resolved. For a product it is the developer or maker, not the product. */
  company?: { qid: string; label: string };
  /** How the company was reached: the item itself, or one hop from the product. */
  via?: "item" | "developer" | "manufacturer";
  people: EntityPerson[];
  fromCache: boolean;
}

interface WikidataStatement {
  mainsnak?: { datavalue?: { value?: unknown } };
  qualifiers?: Record<string, unknown[]>;
  rank?: string;
}
interface WikidataEntity {
  id?: string;
  labels?: Record<string, { value?: string }>;
  claims?: Record<string, WikidataStatement[]>;
}

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function itemIds(entity: WikidataEntity | undefined, property: string, currentOnly: boolean): string[] {
  const statements = (entity?.claims?.[property] ?? []).filter((s) => s.rank !== "deprecated");
  // A CEO statement with an end time is a former CEO. The preferred-rank one,
  // when a company marks one, is the current one.
  const current = currentOnly ? statements.filter((s) => (s.qualifiers?.[P.endTime] ?? []).length === 0) : statements;
  const ordered = [...current.filter((s) => s.rank === "preferred"), ...current.filter((s) => s.rank !== "preferred")];
  return ordered
    .map((s) => rec(s.mainsnak?.datavalue?.value)["id"])
    .filter((id): id is string => typeof id === "string" && /^Q\d+$/u.test(id));
}

function label(entity: WikidataEntity | undefined): string | undefined {
  return entity?.labels?.["en"]?.value ?? Object.values(entity?.labels ?? {})[0]?.value;
}

function hostOf(url: string): string {
  try {
    return new URL(/^https?:\/\//iu.test(url) ? url : `https://${url}`).hostname.replace(/^www\./u, "").toLowerCase();
  } catch {
    return url.replace(/^www\./u, "").toLowerCase();
  }
}

export interface EntityPeopleToolOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * `research.entityPeople` — the people a company is recognised by: its
 * current CEO, then its founders, from Wikidata.
 *
 * ## Why this exists
 *
 * The owner, on a carousel about ChatGPT that shipped a desk-lamp stock photo:
 * *"if it is about ChatGPT you can add a picture of them or of Sam Altman"*.
 * The Instagram entity route could fetch a picture OF a named thing, but only
 * of a thing the run's own evidence named, and the evidence of a story about
 * OpenAI rarely spells out who runs it. The answer is not a model's memory,
 * which is exactly the "right often enough to make the wrong ones invisible"
 * failure the entity route's `officialDomain` rule refuses. It is a structured
 * public record: Wikidata's CEO (P169) and founded-by (P112) statements.
 *
 * A product is followed ONE hop, to its developer (P178) or manufacturer
 * (P176), because a reader recognises ChatGPT by OpenAI's people, not by a
 * product that has none.
 *
 * Public API, no credential, cached per entity. A name Wikidata cannot place
 * returns an empty list, never a guess.
 */
export function createEntityPeople(store: WorkspaceStoreLike, options: EntityPeopleToolOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function getJson(params: Record<string, string>): Promise<unknown> {
    const url = `${WIKIDATA_API}?${new URLSearchParams({ ...params, format: "json", origin: "*" }).toString()}`;
    const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Wikidata answered ${response.status}`);
    return response.json();
  }

  async function entities(ids: readonly string[]): Promise<Record<string, WikidataEntity>> {
    if (ids.length === 0) return {};
    const body = rec(await getJson({ action: "wbgetentities", ids: ids.slice(0, 20).join("|"), props: "labels|claims", languages: "en" }));
    return rec(body["entities"]) as Record<string, WikidataEntity>;
  }

  return defineTool<EntityPeopleInput, EntityPeopleResult>({
    name: "research.entityPeople",
    description:
      "The people a company is recognised by (its current CEO, then its founders), from Wikidata. A product is followed one hop to its developer or maker. Use it to find a face for a story about a company whose evidence never names one. Public API, cached per entity; an unplaceable name returns no people, never a guess.",
    version: TOOL_VERSION,
    inputSchema: EntityPeopleInputSchema,
    async execute(rawInput, { ctx }) {
      const input = rawInput as z.output<typeof EntityPeopleInputSchema>;
      const query = `${input.kind}:${input.name.trim().toLowerCase()}${input.officialDomain ? `@${hostOf(input.officialDomain)}` : ""}`;
      const cached = await latestRunForQuery(store, ctx.clientSlug, JOB, query);
      if (cached && Date.now() - cached.at <= parseDurationMs(input.window)) {
        return success<EntityPeopleResult>({ ...(cached.result as Omit<EntityPeopleResult, "fromCache">), fromCache: true });
      }

      let result: Omit<EntityPeopleResult, "fromCache">;
      try {
        const search = rec(await getJson({ action: "wbsearchentities", search: input.name.trim(), language: "en", uselang: "en", type: "item", limit: "6" }));
        const candidateIds = (Array.isArray(search["search"]) ? search["search"] : [])
          .map((hit) => rec(hit)["id"])
          .filter((id): id is string => typeof id === "string");
        const candidates = await entities(candidateIds);

        // The item: a domain match first, then the first candidate that
        // carries any of the statements this tool follows. A same-named band,
        // film or village carries none of them and is passed over.
        const wantedHost = input.officialDomain ? hostOf(input.officialDomain) : undefined;
        const followed = input.kind === "company" ? [P.ceo, P.foundedBy, P.chairperson] : [P.developer, P.manufacturer];
        const ordered = candidateIds.map((id) => candidates[id]).filter((e): e is WikidataEntity => e !== undefined);
        const byDomain =
          wantedHost === undefined
            ? undefined
            : ordered.find((e) =>
                (e.claims?.[P.officialWebsite] ?? []).some((s) => {
                  const value = s.mainsnak?.datavalue?.value;
                  return typeof value === "string" && hostOf(value) === wantedHost;
                }),
              );
        const item = byDomain ?? ordered.find((e) => followed.some((property) => (e.claims?.[property] ?? []).length > 0));

        let company: WikidataEntity | undefined = item;
        let via: EntityPeopleResult["via"] = item === undefined ? undefined : "item";
        if (item !== undefined && input.kind === "product") {
          const developer = itemIds(item, P.developer, false)[0];
          const maker = developer === undefined ? itemIds(item, P.manufacturer, false)[0] : undefined;
          const companyId = developer ?? maker;
          company = companyId === undefined ? undefined : (await entities([companyId]))[companyId];
          via = companyId === undefined ? undefined : developer !== undefined ? "developer" : "manufacturer";
        }

        const roles: Array<[EntityPerson["role"], string[]]> = [
          ["ceo", itemIds(company, P.ceo, true)],
          ["founder", itemIds(company, P.foundedBy, false)],
          ["chairperson", itemIds(company, P.chairperson, true)],
        ];
        const personIds = [...new Set(roles.flatMap(([, ids]) => ids))];
        const people = await entities(personIds);
        const picked: EntityPerson[] = [];
        for (const [role, ids] of roles) {
          for (const qid of ids) {
            if (picked.length >= MAX_PEOPLE || picked.some((p) => p.qid === qid)) continue;
            const person = people[qid];
            // Only a human. A founding statement that names a parent company
            // is a real record and not a face.
            const isHuman = itemIds(person, P.instanceOf, false).includes(P.human);
            const name = label(person);
            if (isHuman && name !== undefined) picked.push({ name, role, qid });
          }
        }
        const companyLabel = label(company);
        result = {
          runId: randomUUID(),
          ...(company?.id !== undefined && companyLabel !== undefined ? { company: { qid: company.id, label: companyLabel } } : {}),
          ...(via !== undefined && company !== undefined ? { via } : {}),
          people: picked,
        };
      } catch (error) {
        return toolingError(`research.entityPeople: Wikidata read failed: ${(error as Error).message}`);
      }

      const record: RunRecord = { job: JOB, runId: result.runId, query, result, at: Date.now() };
      await writeRunRecord(store, ctx.clientSlug, record);
      return success<EntityPeopleResult>({ ...result, fromCache: false });
    },
  });
}
