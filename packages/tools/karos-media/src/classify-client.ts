import { z } from "zod";
import { defineTool, notAvailable, success, toolingError } from "@agent-engine/tool-common";
import { DEFAULT_VISION_MODEL, type VisionAnalysisClient } from "./visual-patterns.js";

const TOOL_VERSION = "1.0.0";
const RATE_LIMIT_RETRIES = 3;

/**
 * The five-card account classification (2026-09-25; research round #253,
 * `09-architecture-conclusions.md` §2.5), as one cheap text call. The closed
 * lists live here and in `@agent-engine/workflow`'s `client-classification`,
 * which validates what this returns and stores it; this tool only asks.
 *
 * The owner, 2026-09-25: classification is automatic for every client. The
 * workflow primitive calls this only when no staff record, stored belief or
 * research record exists, so a client pays for it once.
 */
export const CLASSIFY_CLIENT_INSTRUCTIONS = `You classify a business's Instagram account on five closed cards. Read only what the client says about itself (below). Reply with JSON only: {"archetype","category","involvement","audience","locale","archetypeReason","categoryReason","involvementReason","audienceReason","localeReason"}, each reason one short sentence.

archetype (the voice the account posts in, not its industry):
- brand: a consumer product brand
- place: a local business, venue or property
- person: a creator, artist, personality or educator posting as themselves
- publisher: media, news or curation
- platform: a consumer app, software product or marketplace
- business: a B2B company, agency or service
- institution: a programme, event, competition or community
Tie-break: first-person human = person; editorial or curatorial = publisher.

involvement (of the PRIMARY revenue line the feed converts):
(a) Is the posting itself what the audience comes for, with money following attention? -> none
(b) Otherwise, does acting need research, money or commitment: a regulated category, a typical order above ~$100, a B2B contract, or an application costing days? -> high
(c) Otherwise -> low

audience: B2B, B2C or mixed.
locale: the language the client publishes in: en, he, pt-BR, es, fr, or multi.
category: one of marketing-advertising, tech-business-news, startups-venture, fashion-intimates, travel-local-discovery, personal-finance-investing, music-nightlife, luxury-hospitality-real-estate when it fits; otherwise a new short kebab-case key naming what the content is about (for example "food-restaurants"). Never "other".`;

export const ClassifyClientInputSchema = z.object({
  evidence: z.string().min(1).max(6000).describe("What the client says about itself (profile, config and brand lines), already assembled by the caller."),
});
export type ClassifyClientInput = z.infer<typeof ClassifyClientInputSchema>;

export interface ClassifyClientResult {
  archetype?: string;
  category?: string;
  involvement?: string;
  audience?: string;
  locale?: string;
  archetypeReason?: string;
  categoryReason?: string;
  involvementReason?: string;
  audienceReason?: string;
  localeReason?: string;
  model: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createClassifyClient(options: { client?: VisionAnalysisClient; model?: string; backoffMs?: number } = {}) {
  const model = options.model ?? DEFAULT_VISION_MODEL;
  const backoffMs = options.backoffMs ?? 2000;
  return defineTool<ClassifyClientInput, ClassifyClientResult>({
    name: "media.classifyClient",
    description:
      "Classify the client's Instagram account on five closed cards (archetype, category, involvement, audience, locale) from what the client says about itself. One cheap text call; the caller validates and stores the answer.",
    version: TOOL_VERSION,
    inputSchema: ClassifyClientInputSchema,
    async execute(args) {
      const client = options.client;
      if (client === undefined) return notAvailable<ClassifyClientResult>("no Vertex credential is configured for text classification");
      let text: string | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await client.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ text: `${CLASSIFY_CLIENT_INSTRUCTIONS}\n\nWhat the client says about itself:\n${args.evidence}` }] }],
            config: { responseMimeType: "application/json" },
          });
          text = response.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
          break;
        } catch (error) {
          const message = (error as Error).message;
          if (attempt < RATE_LIMIT_RETRIES && /429|RESOURCE_EXHAUSTED|Resource exhausted/iu.test(message)) {
            await sleep(backoffMs * (attempt + 1));
            continue;
          }
          return toolingError<ClassifyClientResult>(`classification call failed: ${message.slice(0, 200)}`);
        }
      }
      try {
        const parsed = JSON.parse((text ?? "").replace(/^```(?:json)?\s*|\s*```$/gu, "")) as Record<string, unknown>;
        const pick = (key: string): string | undefined => (typeof parsed[key] === "string" ? (parsed[key] as string) : undefined);
        const result: ClassifyClientResult = { model };
        for (const key of ["archetype", "category", "involvement", "audience", "locale", "archetypeReason", "categoryReason", "involvementReason", "audienceReason", "localeReason"] as const) {
          const value = pick(key);
          if (value !== undefined) result[key] = value;
        }
        return success(result);
      } catch {
        return toolingError<ClassifyClientResult>("the classification reply was not JSON");
      }
    },
  });
}
