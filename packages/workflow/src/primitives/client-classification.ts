import { z } from "zod";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import type { WorkflowContext } from "./context.js";

/**
 * WHAT KIND OF ACCOUNT A CLIENT IS: five picks, made once, automatically.
 *
 * The 2026-09-24 research round (`docs/research/2026-09-24-instagram-owner-
 * feedback/09-architecture-conclusions.md` §2.5, 183 benchmark accounts)
 * found that the cards that carry signal are the account's ARCHETYPE, its
 * INVOLVEMENT (how much research, money or commitment acting on a post
 * costs the reader) and its AUDIENCE, and that industry, read as free text,
 * is the weakest of them. Every agent read "industry" through its own regex
 * until now; this is the one record they can all read instead.
 *
 * The owner, 2026-09-25: automatic for every client from now on, in prep and
 * prod. So it lives in a shared primitive any agent's run calls, and the
 * result is a client-level belief (`memory.updateBeliefs`), which every
 * product of the client reads. Precedence, highest first: a staff record on
 * the profile (`profile.classification`, the portal's field), the stored
 * belief, the research record for the nine clients it covered (approved),
 * then one cheap model call through `media.classifyClient`. A deployment
 * without that tool is unconfigured, not failed: the run proceeds
 * unclassified, exactly as a deployment without the harvest does.
 *
 * Performance never reclassifies a client (§2.5). A staff edit does.
 */

export const ARCHETYPES = ["brand", "place", "person", "publisher", "platform", "business", "institution"] as const;
export const INVOLVEMENTS = ["none", "low", "high"] as const;
export const AUDIENCES = ["B2B", "B2C", "mixed"] as const;
export const LOCALES = ["en", "he", "pt-BR", "es", "fr", "multi"] as const;
export type Archetype = (typeof ARCHETYPES)[number];
export type Involvement = (typeof INVOLVEMENTS)[number];
export type Audience = (typeof AUDIENCES)[number];
export type Locale = (typeof LOCALES)[number];

/** The category packs the research wrote (`guidelines/ig-kit-<key>.md`). A classifier may name a new kebab-case key; never "other". */
export const KNOWN_CATEGORIES = [
  "marketing-advertising",
  "tech-business-news",
  "startups-venture",
  "fashion-intimates",
  "travel-local-discovery",
  "personal-finance-investing",
  "music-nightlife",
  "luxury-hospitality-real-estate",
] as const;

export type ClassificationSource = "staff" | "classifier" | "research-2026-09-25";

export interface ClientClassification {
  archetype: Archetype;
  category: string;
  involvement: Involvement;
  audience: Audience;
  locale: Locale;
  rationale: Partial<Record<"archetype" | "category" | "involvement" | "audience" | "locale", string>>;
  source: ClassificationSource;
  classifiedAt: string;
  version: number;
}

export const CLASSIFICATION_BELIEF_KEY = "clientClassification";
export const CLASSIFICATION_VERSION = 1;

const CategoryKey = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .refine((key) => key !== "other" && key !== "unknown", "a category is never 'other'");

export const ClientClassificationSchema = z.object({
  archetype: z.enum(ARCHETYPES),
  category: CategoryKey,
  involvement: z.enum(INVOLVEMENTS),
  audience: z.enum(AUDIENCES),
  locale: z.enum(LOCALES),
  rationale: z.record(z.string(), z.string()).default({}),
  source: z.enum(["staff", "classifier", "research-2026-09-25"]),
  classifiedAt: z.string(),
  version: z.number().int().positive(),
});

/** A stored record, or `undefined` for anything that does not parse. A malformed record is re-derived, never trusted. */
export function readClassification(value: unknown): ClientClassification | undefined {
  const parsed = ClientClassificationSchema.safeParse(value);
  return parsed.success ? (parsed.data as ClientClassification) : undefined;
}

/**
 * The research record for the nine clients the 2026-09-24 study classified
 * by hand (§4.3), approved by the owner on 2026-09-25 for prep and prod. A
 * migration, not a rule: it is written as the client's belief on the first
 * run that finds no record, and from then on the belief is the data.
 */
const RESEARCH_CLASSIFICATIONS: Readonly<Record<string, Omit<ClientClassification, "source" | "classifiedAt" | "version">>> = {
  karoslabs: { archetype: "business", category: "marketing-advertising", involvement: "high", audience: "B2B", locale: "en", rationale: { involvement: "a B2B contract" } },
  geektime: { archetype: "publisher", category: "tech-business-news", involvement: "none", audience: "mixed", locale: "he", rationale: { involvement: "the posting is what the audience comes for" } },
  thepitchbydeel: { archetype: "institution", category: "startups-venture", involvement: "high", audience: "mixed", locale: "en", rationale: { involvement: "an application costing days" } },
  hankypanky: { archetype: "brand", category: "fashion-intimates", involvement: "low", audience: "B2C", locale: "en", rationale: { involvement: "typical order under ~$100 (re-check at ~$100)" } },
  kindlyyours: { archetype: "brand", category: "fashion-intimates", involvement: "low", audience: "B2C", locale: "en", rationale: {} },
  sitti: { archetype: "platform", category: "travel-local-discovery", involvement: "low", audience: "mixed", locale: "en", rationale: { archetype: "platform, neighbour publisher" } },
  xodigital: { archetype: "platform", category: "personal-finance-investing", involvement: "high", audience: "B2C", locale: "pt-BR", rationale: { involvement: "regulated category" } },
  dontechno: { archetype: "publisher", category: "music-nightlife", involvement: "none", audience: "B2C", locale: "en", rationale: { archetype: "publisher, neighbour person" } },
  n3: { archetype: "place", category: "luxury-hospitality-real-estate", involvement: "high", audience: "B2C", locale: "fr", rationale: {} },
};

export function researchClassificationFor(clientSlug: string, now: Date): ClientClassification | undefined {
  const row = RESEARCH_CLASSIFICATIONS[clientSlug];
  return row === undefined ? undefined : { ...row, source: "research-2026-09-25", classifiedAt: now.toISOString(), version: CLASSIFICATION_VERSION };
}

/** Where a run's record came from, for the trace and the gate payload. */
export type ClassificationOrigin = "profile" | "belief" | "research" | "classifier";

export interface ClassificationResolution {
  classification?: ClientClassification;
  origin?: ClassificationOrigin;
  notes: string[];
}

/** The words the classifier reads: what the client says about itself. Capped, so a long profile cannot turn a one-cent call into a dollar. */
export function classifierEvidence(input: { profile?: Record<string, unknown>; config?: Record<string, unknown>; brand?: Record<string, unknown> }): string {
  const pick = (source: Record<string, unknown> | undefined, keys: readonly string[]): string[] =>
    keys.flatMap((key) => {
      const value = source?.[key];
      if (typeof value === "string" && value.trim().length > 0) return [`${key}: ${value.trim()}`];
      if (Array.isArray(value)) {
        const strings = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
        return strings.length > 0 ? [`${key}: ${strings.join(", ")}`] : [];
      }
      return [];
    });
  const lines = [
    ...pick(input.profile, ["name", "category", "industry", "website", "description", "tagline", "about", "audience", "products", "services", "language", "languages", "country", "market"]),
    ...pick(input.config, ["industry", "language", "targetLanguage", "market", "audience"]),
    ...pick(input.brand, ["tagline", "voice", "mission"]),
  ];
  return lines.join("\n").slice(0, 4000);
}

const ClassifierOutputSchema = z.object({
  archetype: z.enum(ARCHETYPES),
  category: z.string(),
  involvement: z.enum(INVOLVEMENTS),
  audience: z.enum(AUDIENCES),
  locale: z.enum(LOCALES),
  archetypeReason: z.string().optional(),
  categoryReason: z.string().optional(),
  involvementReason: z.string().optional(),
  audienceReason: z.string().optional(),
  localeReason: z.string().optional(),
});
type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>;

/** The model's answer as a record, or `undefined` when a card is off the closed lists. The category is normalised to kebab-case. */
export function classificationFromModel(output: unknown, now: Date): ClientClassification | undefined {
  const parsed = ClassifierOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const o: ClassifierOutput = parsed.data;
  const category = o.category
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (category.length === 0 || category === "other" || category === "unknown") return undefined;
  const rationale: ClientClassification["rationale"] = {};
  if (o.archetypeReason) rationale.archetype = o.archetypeReason;
  if (o.categoryReason) rationale.category = o.categoryReason;
  if (o.involvementReason) rationale.involvement = o.involvementReason;
  if (o.audienceReason) rationale.audience = o.audienceReason;
  if (o.localeReason) rationale.locale = o.localeReason;
  return { archetype: o.archetype, category, involvement: o.involvement, audience: o.audience, locale: o.locale, rationale, source: "classifier", classifiedAt: now.toISOString(), version: CLASSIFICATION_VERSION };
}

export interface ClientClassificationDeps {
  tools: AgentToolRegistry;
}

/**
 * The client's classification, resolving it the first time any run needs it.
 *
 * Fails open: a run whose classification cannot be resolved gets `undefined`
 * and every consumer keeps its previous behaviour. Checkpointed, so a resume
 * neither re-reads nor re-pays.
 */
export async function resolveClientClassification(wf: WorkflowContext, deps: ClientClassificationDeps, options: { stepPrefix?: string; now?: () => Date } = {}): Promise<ClassificationResolution> {
  const prefix = options.stepPrefix ?? "00a2";
  const now = options.now ?? (() => new Date());
  const ctx: AgentContext = {
    runId: wf.runId,
    clientSlug: wf.clientSlug,
    productId: wf.productId,
    runKind: wf.runKind,
    ...(wf.slotId !== undefined ? { slotId: wf.slotId } : {}),
    metadata: {},
  };
  const read = async (name: string, input: Record<string, unknown> = {}): Promise<unknown> => {
    try {
      const got = await deps.tools[name]?.execute(input, { ctx });
      return got?.status === "success" ? got.result : undefined;
    } catch {
      return undefined;
    }
  };

  const known = await wf.step.code(`${prefix}-read-client-classification`, async () => {
    const profile = (await read("client.getProfile")) as Record<string, unknown> | undefined;
    const staff = readClassification(profile?.["classification"]);
    if (staff !== undefined) return { origin: "profile" as const, classification: staff };
    const memory = (await read("memory.read", { scope: "beliefs" })) as { beliefs?: Record<string, unknown> } | undefined;
    const stored = readClassification(memory?.beliefs?.[CLASSIFICATION_BELIEF_KEY]);
    if (stored !== undefined) return { origin: "belief" as const, classification: stored };
    const research = researchClassificationFor(wf.clientSlug, now());
    if (research !== undefined) return { origin: "research" as const, classification: research, persist: true as const };
    const config = (await read("client.getConfig")) as Record<string, unknown> | undefined;
    const brand = (await read("client.getBrand")) as Record<string, unknown> | undefined;
    return { origin: undefined, evidence: classifierEvidence({ ...(profile !== undefined ? { profile } : {}), ...(config !== undefined ? { config } : {}), ...(brand !== undefined ? { brand } : {}) }) };
  });

  let classification = known.classification;
  let origin: ClassificationOrigin | undefined = known.origin;
  const notes: string[] = [];
  let persist = "persist" in known && known.persist === true;

  if (classification === undefined) {
    const evidence = "evidence" in known ? (known.evidence ?? "") : "";
    if (evidence.trim().length === 0) {
      notes.push("client classification: nothing on file describes this client yet; the run proceeds unclassified and the next run tries again");
      return { notes };
    }
    if (deps.tools["media.classifyClient"] === undefined) {
      notes.push("client classification: media.classifyClient is not registered on this deployment; the run proceeds unclassified");
      return { notes };
    }
    const answered = await wf.step.code(`${prefix}1-classify-client`, async () => {
      try {
        const got = await deps.tools["media.classifyClient"]!.execute({ evidence }, { ctx });
        return got.status === "success" ? { ok: true as const, result: got.result } : { ok: false as const, reason: got.status };
      } catch (error) {
        return { ok: false as const, reason: (error as Error).message.slice(0, 200) };
      }
    });
    classification = answered.ok ? classificationFromModel(answered.result, now()) : undefined;
    if (classification === undefined) {
      notes.push(`client classification: the classifier did not return a usable record (${answered.ok ? "off the closed lists" : answered.reason}); the run proceeds unclassified`);
      return { notes };
    }
    origin = "classifier";
    persist = true;
  }

  if (persist) {
    const record = classification;
    await wf.step.code(`${prefix}2-persist-client-classification`, async () => {
      try {
        await deps.tools["memory.updateBeliefs"]?.execute({ diff: { [CLASSIFICATION_BELIEF_KEY]: record } }, { ctx });
        return { persisted: true };
      } catch (error) {
        return { persisted: false, error: (error as Error).message };
      }
    });
  }
  notes.push(`client classification (${origin}): ${classification.archetype} · ${classification.category} · ${classification.involvement} · ${classification.audience} · ${classification.locale}`);
  return { classification, ...(origin !== undefined ? { origin } : {}), notes };
}
