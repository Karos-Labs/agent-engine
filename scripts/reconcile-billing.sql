-- SCRUM-361 acceptance 3: reconcile engine-computed Claude spend against the
-- actual Vertex bill, for one billing period.
--
-- BLOCKED ON DATA, NOT ON THIS QUERY. `billing_export` exists as a dataset with
-- NO TABLES in both karoscmo and karoscmo-prep. The Cloud Billing BigQuery
-- export has to be enabled per billing account from the Console — it cannot be
-- enabled by API — and the two projects bill to different accounts:
--
--   prod  karoscmo       -> billingAccounts/01CD98-A99719-71B855
--   prep  karoscmo-prep  -> billingAccounts/01DD27-5303C6-631391
--
-- So this runs twice, once per account, against that account's own export.
--
-- ============================================================================
-- ASSUMPTIONS THIS QUERY MAKES ABOUT THE EXPORT SCHEMA
-- ============================================================================
--
-- Every one is an assumption until the table exists. Check each against the
-- real schema before trusting the delta — a reconciliation built on a guessed
-- column name is exactly the "plausible number nobody checked" this ticket is
-- about.
--
--   1. TABLE NAME. Detailed usage cost export is
--      `gcp_billing_export_resource_v1_<ACCOUNT_ID_WITH_UNDERSCORES>`.
--      Standard export (no `resource` segment) also works for this query —
--      it lacks per-resource detail we do not use here.
--   2. `service.description` = 'Vertex AI' for Anthropic-on-Vertex charges.
--      NOT VERIFIED. Anthropic models are billed through Vertex's Model Garden
--      as a partner/MaaS SKU, and those sometimes appear under their own
--      service description. If the first run returns zero rows, widen to
--      `service.description LIKE '%AI%'` and inspect `sku.description` before
--      narrowing again.
--   3. `sku.description` contains 'Claude' or 'Anthropic'. Also not verified,
--      and the most likely thing to be wrong. The DISTINCT-SKU query at the
--      bottom exists to be run FIRST.
--   4. `cost` is in the billing account's currency and EXCLUDES credits.
--      `credits` is a repeated field; net cost is cost + SUM(credits.amount),
--      and credits are negative. This query reports both so a promotional
--      credit cannot silently close the gap.
--   5. `usage_start_time` is UTC, matching the engine's own timestamps.
--
-- ============================================================================
-- STEP 0 — RUN THIS FIRST. Do not skip it.
-- ============================================================================
-- Assumptions 2 and 3 are guesses. This tells you what the SKUs are actually
-- called before anything is summed.
--
--   SELECT DISTINCT service.description AS service, sku.description AS sku
--   FROM `PROJECT.billing_export.gcp_billing_export_resource_v1_XXXXXX`
--   WHERE usage_start_time >= TIMESTAMP('2026-08-01')
--     AND (LOWER(sku.description) LIKE '%claude%'
--       OR LOWER(sku.description) LIKE '%anthropic%'
--       OR LOWER(service.description) LIKE '%vertex%')
--   ORDER BY service, sku;

-- ============================================================================
-- STEP 1 — billed Claude spend for the period
-- ============================================================================
WITH billed AS (
  SELECT
    DATE(usage_start_time)                              AS day,
    SUM(cost)                                           AS billed_cost,
    SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS credits,
    SUM(cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS billed_net
  FROM `PROJECT.billing_export.gcp_billing_export_resource_v1_XXXXXX`
  WHERE usage_start_time >= TIMESTAMP('2026-08-01')
    AND usage_start_time <  TIMESTAMP('2026-09-01')
    AND (LOWER(sku.description) LIKE '%claude%' OR LOWER(sku.description) LIKE '%anthropic%')
  GROUP BY day
),

-- ============================================================================
-- STEP 2 — engine-computed Claude spend for the same period
-- ============================================================================
-- `model LIKE 'claude%'` is exact here, not a guess: `MODEL_PRICING` keys and
-- `AgentPlatformAdapter`'s canonical ids are both `claude-*`, and
-- agent-platform-model-ids.ts normalises the `@`-dated Vertex spelling back to
-- the hyphenated canonical form before telemetry sees it.
--
-- FALLBACK ROWS ARE EXCLUDED, and this is load-bearing. A Claude call served
-- by the fallback is still `claude-*` and still costs money — but it is billed
-- by ANTHROPIC, not by Google, so including it would inflate the engine side
-- against a Google bill that never saw it. In the two production runs measured
-- on 2026-08-27, 11 model calls went that way.
--
-- `servedByHop` / `servingAdapter` were added to this table for exactly this
-- (SCRUM-360 → SCRUM-361 item 3). Rows written before they existed have NULL,
-- which the filter below treats as Vertex-served — correct for historical rows,
-- since the columns postdate them and the fallback share was not separable then
-- either. Restrict the window to after they were populated for a clean delta.
--
-- The excluded spend is not lost: it is the second bill, quantified in the
-- companion query at the bottom of this file.
computed AS (
  SELECT
    DATE(timestamp)   AS day,
    SUM(costUsd)      AS computed_cost,
    COUNT(*)          AS calls,
    SUM(inputTokens)  AS input_tokens,
    SUM(outputTokens) AS output_tokens
  FROM `PROJECT.bi_telemetry.agent_runs_bi`
  WHERE timestamp >= TIMESTAMP('2026-08-01')
    AND timestamp <  TIMESTAMP('2026-09-01')
    AND LOWER(model) LIKE 'claude%'
    -- Vertex-billed only. NULL = pre-column row, treated as primary.
    AND (servedByHop IS NULL OR servedByHop = 'primary')
  GROUP BY day
)

-- ============================================================================
-- STEP 3 — the delta, which is the entire deliverable
-- ============================================================================
SELECT
  COALESCE(b.day, c.day)                     AS day,
  ROUND(c.computed_cost, 6)                  AS engine_computed,
  ROUND(b.billed_net, 6)                     AS google_billed_net,
  ROUND(c.computed_cost - b.billed_net, 6)   AS delta_usd,
  SAFE_DIVIDE(c.computed_cost - b.billed_net, NULLIF(b.billed_net, 0)) AS delta_ratio,
  c.calls,
  c.input_tokens,
  c.output_tokens,
  ROUND(b.credits, 6)                        AS credits_applied
FROM computed c
FULL OUTER JOIN billed b USING (day)
ORDER BY day;

-- ============================================================================
-- HOW TO READ THE RESULT
-- ============================================================================
-- A day present in `computed` and absent from `billed` is not necessarily an
-- error: Anthropic-on-Vertex may bill under a SKU assumption 3 missed, or the
-- calls may have gone to the direct-Anthropic fallback and never reached
-- Google at all. Resolve that with STEP 0 before concluding anything.
--
-- Whatever the delta is, WRITE IT ON SCRUM-361. The point of this exercise is
-- not to find the delta small — it is to stop the number being unbounded. Two
-- production runs are already measured exactly and are the natural spot-check:
--
--   pubsub-21091607732714829   $0.319324   (instagram, 2026-08-27)
--   pubsub-21091608153312771   $0.128309   (linkedin,  2026-08-27, and this
--                                           one's BigQuery row sum matches the
--                                           run record to the cent)

-- ============================================================================
-- COMPANION: THE SECOND BILL (SCRUM-361 task 5)
-- ============================================================================
-- Claude spend that went to the DIRECT-ANTHROPIC hop. This is billed on an
-- Anthropic invoice against ANTHROPIC_API_KEY, not by Google, and nothing on
-- the board currently reconciles it. Run it alongside the query above; the two
-- should sum to total Claude spend.
--
-- SELECT
--   DATE(timestamp)      AS day,
--   servingAdapter,
--   COUNT(*)             AS calls,
--   ROUND(SUM(costUsd), 6) AS anthropic_billed_estimate
-- FROM `PROJECT.bi_telemetry.agent_runs_bi`
-- WHERE LOWER(model) LIKE 'claude%'
--   AND servedByHop IS NOT NULL AND servedByHop != 'primary'
-- GROUP BY day, servingAdapter
-- ORDER BY day;
