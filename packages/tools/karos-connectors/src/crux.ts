import { z } from "zod";
import { allowlistedRead, type ReadRuntime } from "./read.js";
import { CRUX_DERIVED_ALLOWLIST } from "./allowlist.js";
import type { ConnectorReadOutcome, GoogleConnection } from "./types.js";

/**
 * PageSpeed Insights / CrUX — the two methods named in `connectors[2].api`:
 *
 *   pagespeedonline.runpagespeed · chromeuxreport.records:queryRecord
 *
 * See `allowlist.ts`'s `CRUX_DERIVED_ALLOWLIST` for why these are DERIVED
 * rather than transcribed: the crux connector is the one entry in
 * `connectors-config.data.ts` with no `read_methods_allowlist` array at all.
 *
 * This connector carries no OAuth scope — `connectors[2].oauth_scope_readonly`
 * is literally "NONE — key-gated via PSI_API_KEY (no per-client OAuth)" — so
 * nothing here mints or takes a bearer token, and it does not ride the token
 * table (`connectors[2].note`).
 *
 * ## The Defect-2 gate is enforced here, not documented here
 *
 * `crux_per_client_gate`: *"crux_snapshot_hash un-drops ONLY on a per-client
 * Google-connect opt-in, never on the global PSI_API_KEY landing. SEO-04
 * lab->field is therefore always a logged per-client source change + version
 * bump."* `assertCruxOptIn` below is that rule as code: having the key is not
 * permission to read field data for a client who did not opt in, because the
 * read is what silently flips SEO-04 from lab to field.
 */
const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CRUX_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";

/** Destructured from the one derived table rather than retyped, so the two can never disagree about a method token. */
export const [PAGESPEED_RUNPAGESPEED, CRUX_QUERY_RECORD] = CRUX_DERIVED_ALLOWLIST;

const MetricPercentilesSchema = z.object({ p75: z.union([z.number(), z.string()]).optional() });
const CruxMetricSchema = z.object({
  percentiles: MetricPercentilesSchema.optional(),
  histogram: z.array(z.object({ start: z.union([z.number(), z.string()]).optional(), end: z.union([z.number(), z.string()]).optional(), density: z.number().optional() })).optional(),
});

export const CruxQueryRecordResponseSchema = z.object({
  record: z.object({
    key: z.object({ origin: z.string().optional(), url: z.string().optional(), formFactor: z.string().optional() }).optional(),
    metrics: z
      .object({
        largest_contentful_paint: CruxMetricSchema.optional(),
        interaction_to_next_paint: CruxMetricSchema.optional(),
        cumulative_layout_shift: CruxMetricSchema.optional(),
      })
      .optional(),
    collectionPeriod: z.object({ firstDate: z.unknown().optional(), lastDate: z.unknown().optional() }).optional(),
  }),
});
export type CruxQueryRecordResponse = z.infer<typeof CruxQueryRecordResponseSchema>;

const LoadingExperienceMetricSchema = z.object({ percentile: z.number().optional(), category: z.string().optional() });

export const PagespeedResponseSchema = z.object({
  id: z.string().optional(),
  /** Present only when CrUX has field data for this URL/origin; absent is the documented lab-fallback case, not an error. */
  loadingExperience: z
    .object({
      metrics: z
        .object({
          LARGEST_CONTENTFUL_PAINT_MS: LoadingExperienceMetricSchema.optional(),
          INTERACTION_TO_NEXT_PAINT: LoadingExperienceMetricSchema.optional(),
          CUMULATIVE_LAYOUT_SHIFT_SCORE: LoadingExperienceMetricSchema.optional(),
        })
        .optional(),
      overall_category: z.string().optional(),
    })
    .optional(),
  lighthouseResult: z
    .object({
      categories: z.object({ performance: z.object({ score: z.number().nullable().optional() }).optional() }).optional(),
      audits: z.record(z.string(), z.object({ id: z.string().optional(), title: z.string().optional(), score: z.number().nullable().optional(), numericValue: z.number().optional(), displayValue: z.string().optional() })).optional(),
    })
    .optional(),
});
export type PagespeedResponse = z.infer<typeof PagespeedResponseSchema>;

/** Thrown when a caller asks for CrUX field data for a client that has not set the per-client opt-in (Defect-2). */
export class CruxOptInRequiredError extends Error {
  constructor(clientId: string) {
    super(
      `client "${clientId}" has not set the per-client Google-connect opt-in, so CrUX field data may not be read for it. ` +
        `crux_snapshot_hash un-drops on that opt-in ONLY, never on the global PSI_API_KEY landing (connectors-config.data.ts crux_per_client_gate, Defect-2) — ` +
        `reading it anyway would flip SEO-04 lab->field org-wide with no logged per-client source change.`,
    );
    this.name = "CruxOptInRequiredError";
  }
}

export function assertCruxOptIn(connection: Pick<GoogleConnection, "clientId" | "cruxOptIn">): void {
  if (!connection.cruxOptIn) throw new CruxOptInRequiredError(connection.clientId);
}

export interface CruxAuth {
  /** `PSI_API_KEY` — a server secret, sent as the `key` query parameter both endpoints take. */
  apiKey: string;
}

export type CruxFormFactor = "PHONE" | "DESKTOP" | "TABLET" | "ALL_FORM_FACTORS";

/** `chromeuxreport.records:queryRecord` — real-user field p75 LCP/INP/CLS, the connected source for SEO-04. Gated on the per-client opt-in. */
export async function cruxQueryRecord(
  auth: CruxAuth,
  connection: Pick<GoogleConnection, "clientId" | "cruxOptIn">,
  target: { origin?: string; url?: string; formFactor?: CruxFormFactor },
  runtime: ReadRuntime,
): Promise<ConnectorReadOutcome<CruxQueryRecordResponse>> {
  assertCruxOptIn(connection);
  const body: Record<string, unknown> = {};
  if (target.origin !== undefined) body["origin"] = target.origin;
  if (target.url !== undefined) body["url"] = target.url;
  if (target.formFactor !== undefined) body["formFactor"] = target.formFactor;

  return allowlistedRead(
    {
      connector: "crux",
      method: CRUX_QUERY_RECORD,
      url: `${CRUX_ENDPOINT}?key=${encodeURIComponent(auth.apiKey)}`,
      init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      vendor: "the CrUX API",
    },
    runtime,
    CruxQueryRecordResponseSchema,
  );
}

/**
 * `pagespeedonline.runpagespeed` — the Lighthouse lab audit plus its
 * opportunities, which is both SEO-04's per-URL lab fallback ("Per-URL lab
 * fallback when field data absent") and half of `google_own_recommendations`.
 *
 * Deliberately NOT gated on the crux opt-in: the lab audit is the UNCONNECTED
 * default this product already ships (`per_metric_degradation`: "SEO-04 CWV:
 * lab p75 (lighthouse-audit) ... -> full Technical/CWV bucket scores today").
 * Only the field-data swap is the logged source change.
 */
export async function runPagespeed(
  auth: CruxAuth,
  target: { url: string; strategy?: "mobile" | "desktop"; categories?: readonly string[] },
  runtime: ReadRuntime,
): Promise<ConnectorReadOutcome<PagespeedResponse>> {
  const query = new URLSearchParams({ url: target.url, key: auth.apiKey });
  if (target.strategy) query.set("strategy", target.strategy);
  for (const category of target.categories ?? []) query.append("category", category);

  return allowlistedRead(
    { connector: "crux", method: PAGESPEED_RUNPAGESPEED, url: `${PSI_ENDPOINT}?${query.toString()}`, init: { method: "GET" }, vendor: "the PageSpeed Insights API" },
    runtime,
    PagespeedResponseSchema,
  );
}
