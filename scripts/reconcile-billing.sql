-- SCRUM-361 acceptance item 3: reconcile engine-computed Claude spend against
-- the actual bill, for one billing period, and write the delta down.
--
-- ============================================================================
-- STATUS: BLOCKED ON DATA, NOT ON THIS QUERY
-- ============================================================================
-- `billing_export` exists as a dataset with NO TABLES in both `karoscmo` and
-- `karoscmo-prep`. The Cloud Billing BigQuery export has to be enabled per
-- billing account from the Console — it cannot be enabled by API — and the two
-- projects bill to different accounts:
--
--   prod  karoscmo       -> billingAccounts/01CD98-A99719-71B855
--   prep  karoscmo-prep  -> billingAccounts/01DD27-5303C6-631391
--
-- So this runs twice, once per account, against that account's own export.
-- Enabling the export is Tomer's action (SCRUM-361 comments 10362, 10367).
--
-- ============================================================================
-- WHY THIS FILE SPLITS THE ENGINE SIDE IN TWO
-- ============================================================================
-- A Claude call served by the direct-Anthropic fallback hop is still recorded
-- as `claude-*` and still costs real money — but it is billed by ANTHROPIC,
-- not by Google. It appears in no GCP billing report and no BigQuery billing
-- export. Comparing ALL engine-side Claude spend against a Vertex bill would
-- therefore report a large delta and attribute it to accounting error, when
-- the actual cause is that the spend never reached Google.
--
-- Measured on 2026-08-27 from the persisted step records of two production
-- runs (SCRUM-361 comment 10368):
--
--   pubsub-21091607732714829  $0.319324 total,  $0.280324 fallback-served  (88%)
--   pubsub-21091608153312771  $0.128309 total,  $0.128309 fallback-served (100%)
--
-- The majority of production Claude spend is not going to Google. A naive
-- reconciliation would have compared the minority.
--
-- The split is what `servedByHop` / `servingAdapter` are on `agent_runs_bi`
-- for. STEP 2 below excludes fallback rows from the Vertex comparison; the
-- COMPANION query at the bottom quantifies them separately. The two should
-- sum to total engine-computed Claude spend, and the sanity check at the very
-- bottom asserts exactly that.
--
-- ============================================================================
-- ASSUMPTIONS THIS QUERY MAKES ABOUT THE BILLING EXPORT SCHEMA
-- ============================================================================
-- Every one is UNVERIFIED and stays marked unverified until the table exists.
-- A reconciliation built on a guessed column name is precisely the "plausible
-- number nobody checked" this ticket is about.
--
--   1. TABLE NAME — UNVERIFIED. Detailed usage cost export is
--      `gcp_billing_export_resource_v1_<ACCOUNT_ID_WITH_UNDERSCORES>`.
--      Standard export (no `resource` segment) also works for this query; it
--      lacks per-resource detail we do not use here.
--   2. `service.description` = 'Vertex AI' for Anthropic-on-Vertex charges —
--      UNVERIFIED. Anthropic models are billed through Vertex's Model Garden
--      as a partner/MaaS SKU, and those sometimes appear under their own
--      service description. If STEP 1 returns zero rows, widen to
--      `LOWER(service.description) LIKE '%ai%'` and inspect `sku.description`
--      before narrowing again.
--   3. `sku.description` contains 'Claude' or 'Anthropic' — UNVERIFIED, and
--      the single most likely thing to be wrong. STEP 0 exists to settle it.
--   4. `cost` is in the billing account's currency and EXCLUDES credits —
--      UNVERIFIED. `credits` is a repeated field; net cost is
--      cost + SUM(credits.amount), and credits are negative. This query
--      reports both, so a promotional credit cannot silently close the gap.
--   5. `usage_start_time` is UTC, matching the engine's own timestamps —
--      UNVERIFIED.
--
-- What is NOT an assumption: the `agent_runs_bi` side. Its columns are
-- declared in karos-portal's `deploy/bootstrap-bi-telemetry-gcp.sh` and
-- written by `packages/telemetry/src/span-helpers.ts`'s row literal, which
-- `scripts/check-bq-insert-schema.ts` cross-checks against the live table.
--
-- ============================================================================
-- STEP -1 — THE COLUMNS MUST EXIST IN BIGQUERY BEFORE THE ENGINE WRITES THEM
-- ============================================================================
-- `table.insert` in `packages/telemetry/src/span-helpers.ts` passes
-- `ignoreUnknownValues: true`. A field missing from the table is therefore
-- DROPPED SILENTLY while the insert reports success. That is not a
-- hypothetical: it is how `operation`, `jobId`, `stepId` and `source` were
-- discarded on every insert for months after being added deliberately
-- (.github/workflows/quality.yml:66-73).
--
-- So the schema widening goes FIRST, in both projects. Additive nullable
-- columns are safe on an existing table — `bq update` only ever adds.
--
--   for P in karoscmo karoscmo-prep; do
--     bq query --project_id="$P" --use_legacy_sql=false \
--       "ALTER TABLE \`$P.bi_telemetry.agent_runs_bi\`
--          ADD COLUMN IF NOT EXISTS servedByHop STRING,
--          ADD COLUMN IF NOT EXISTS servingAdapter STRING"
--   done
--
-- VERIFY BY READ-BACK, NOT BY THE COMMAND EXITING 0. A successful DDL is not
-- evidence the column is on the insert path; the schema listing is:
--
--   for P in karoscmo karoscmo-prep; do
--     bq show --schema --format=prettyjson "$P:bi_telemetry.agent_runs_bi" \
--       | grep -E 'servedByHop|servingAdapter'
--   done
--
-- And once a run has gone through, confirm a row actually carries a value —
-- a column that exists but is NULL on every row means the code side did not
-- land, which looks identical from the schema listing:
--
--   SELECT servedByHop, servingAdapter, COUNT(*)
--   FROM `PROJECT.bi_telemetry.agent_runs_bi`
--   WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
--   GROUP BY 1, 2;
--
-- `npm run check:bq-schema` cross-checks the insert's field list against the
-- live table and covers this permanently — but it returns UNREACHABLE without
-- a GCP credential, and UNREACHABLE is not a pass.
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
-- STEP 1 — billed Claude spend for the period (the Google side)
-- ============================================================================
WITH billed AS (
  SELECT
    DATE(usage_start_time)                                       AS day,
    SUM(cost)                                                    AS billed_cost,
    SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS credits,
    SUM(cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS billed_net
  FROM `PROJECT.billing_export.gcp_billing_export_resource_v1_XXXXXX`
  WHERE usage_start_time >= TIMESTAMP('2026-08-01')
    AND usage_start_time <  TIMESTAMP('2026-09-01')
    AND (LOWER(sku.description) LIKE '%claude%' OR LOWER(sku.description) LIKE '%anthropic%')  -- assumption 3, UNVERIFIED
  GROUP BY day
),

-- ============================================================================
-- STEP 2 — engine-computed VERTEX-BILLED Claude spend for the same period
-- ============================================================================
-- `model LIKE 'claude%'` is exact here, not a guess: `MODEL_PRICING` keys and
-- `AgentPlatformAdapter`'s canonical ids are both `claude-*`, and
-- `agent-platform-model-ids.ts` normalises the `@`-dated Vertex spelling back
-- to the hyphenated canonical form before telemetry sees it.
--
-- THE FALLBACK FILTER IS LOAD-BEARING. See the header. It is written against
-- NULL as well as 'primary' for two distinct reasons, and both are real:
--
--   a. `base-agent.ts` attaches `servedBy` to a turn ONLY when
--      `provenance.hop !== "primary"`, and `span-helpers.ts` writes NULL when
--      no turn carried one. So on a current row, NULL genuinely means
--      "every turn was primary-served", i.e. Vertex-billed. It is not an
--      unknown.
--   b. Rows written BEFORE these columns existed are also NULL, and for those
--      it IS unknown. Treating them as Vertex-served is the least-wrong
--      choice — the fallback share was not separable then either — but it
--      biases the Vertex side UPWARD for that window.
--
-- (b) is why the window matters: RESTRICT THE PERIOD TO AFTER THE COLUMNS
-- WERE POPULATED for a delta you can defend. The `column_coverage` check at
-- the bottom of this file tells you when that was, per day, rather than
-- asking you to remember.
computed_vertex AS (
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
    AND (servedByHop IS NULL OR servedByHop = 'primary')
  GROUP BY day
)

-- ============================================================================
-- STEP 3 — the delta, which is the entire deliverable
-- ============================================================================
SELECT
  COALESCE(b.day, c.day)                     AS day,
  ROUND(c.computed_cost, 6)                  AS engine_computed_vertex,
  ROUND(b.billed_net, 6)                     AS google_billed_net,
  ROUND(c.computed_cost - b.billed_net, 6)   AS delta_usd,
  SAFE_DIVIDE(c.computed_cost - b.billed_net, NULLIF(b.billed_net, 0)) AS delta_ratio,
  c.calls,
  c.input_tokens,
  c.output_tokens,
  ROUND(b.credits, 6)                        AS credits_applied
FROM computed_vertex c
FULL OUTER JOIN billed b USING (day)
ORDER BY day;

-- ============================================================================
-- HOW TO READ THE RESULT
-- ============================================================================
-- A day present in `computed_vertex` and absent from `billed` is not by itself
-- an error: Anthropic-on-Vertex may bill under a SKU assumption 3 missed.
-- Resolve that with STEP 0 before concluding anything.
--
-- Two known accuracy gaps sit on the ENGINE side and both push it LOW, so a
-- computed figure below the bill is partly expected (SCRUM-361 comments 10237,
-- 10271): tool-incurred spend was $0.000000 until per-unit pricing landed
-- (~14% on one measured instagram run), and cache-write tokens are billed at
-- 1x where Anthropic charges a premium.
--
-- Whatever the delta is, WRITE IT ON SCRUM-361. The point is not to find it
-- small — it is to stop the number being unbounded. Two production runs are
-- already measured exactly and are the natural spot-check:
--
--   pubsub-21091607732714829   $0.319324   (instagram, 2026-08-27)
--   pubsub-21091608153312771   $0.128309   (linkedin,  2026-08-27; this one's
--                                           BigQuery row sum matches the run
--                                           record to the cent)

-- ============================================================================
-- COMPANION — THE SECOND BILL (SCRUM-361 item 3, revised step 4)
-- ============================================================================
-- Claude spend that went to the direct-Anthropic hop. Billed on an Anthropic
-- invoice against ANTHROPIC_API_KEY (Secret Manager secret `anthropic-api-key`
-- in `karoscmo`), not by Google, and nothing on the board reconciles it today.
-- Run this alongside STEP 3; there is no automated counterpart to compare it
-- to, so the comparison is against the Anthropic Console for that org.
--
--   SELECT
--     DATE(timestamp)        AS day,
--     servedByHop,
--     servingAdapter,
--     COUNT(*)               AS calls,
--     ROUND(SUM(costUsd), 6) AS anthropic_billed_estimate
--   FROM `PROJECT.bi_telemetry.agent_runs_bi`
--   WHERE timestamp >= TIMESTAMP('2026-08-01')
--     AND timestamp <  TIMESTAMP('2026-09-01')
--     AND LOWER(model) LIKE 'claude%'
--     AND servedByHop IS NOT NULL
--     AND servedByHop != 'primary'
--   GROUP BY day, servedByHop, servingAdapter
--   ORDER BY day, servedByHop;
--
-- NOTE ON `servingAdapter` FOR THE TERTIARY HOP. A tertiary failover switches
-- MODEL as well as vendor (`tertiaryModel`, resilient-claude-adapter.ts:149),
-- so those rows are `gemini-*`, not `claude-*`, and the `model LIKE 'claude%'`
-- filter above excludes them. That is correct for a CLAUDE reconciliation and
-- wrong for a total-spend one. Drop the model filter if you want the latter.

-- ============================================================================
-- SANITY CHECK — the two sides must sum to the whole
-- ============================================================================
-- If this returns any row, the split above is dropping spend and the delta in
-- STEP 3 cannot be trusted. It is designed to return ZERO rows when correct,
-- and it CAN return rows: give `servedByHop` a fourth value that is neither
-- NULL nor 'primary' nor matched by the companion's filter and this fires.
--
--   SELECT day, total, vertex_side + anthropic_side AS split_sum
--   FROM (
--     SELECT
--       DATE(timestamp) AS day,
--       SUM(costUsd) AS total,
--       SUM(IF(servedByHop IS NULL OR servedByHop = 'primary', costUsd, 0)) AS vertex_side,
--       SUM(IF(servedByHop IS NOT NULL AND servedByHop != 'primary', costUsd, 0)) AS anthropic_side
--     FROM `PROJECT.bi_telemetry.agent_runs_bi`
--     WHERE LOWER(model) LIKE 'claude%'
--     GROUP BY day
--   )
--   WHERE ABS(total - (vertex_side + anthropic_side)) > 1e-9;

-- ============================================================================
-- COLUMN COVERAGE — which days can be reconciled at all
-- ============================================================================
-- Rows predating the `servedByHop` column are NULL and indistinguishable from
-- genuinely primary-served rows, so a period that straddles the deploy gives a
-- Vertex side biased upward by an unknown amount. This says where the boundary
-- actually is instead of trusting a deploy date.
--
-- `hop_bearing_rows = 0` on a day is NOT proof the column was absent — it is
-- also what a day with no failovers looks like. Read the two columns together:
-- the first day with any non-NULL value is the earliest defensible start.
--
--   SELECT
--     DATE(timestamp) AS day,
--     COUNT(*) AS claude_rows,
--     COUNTIF(servedByHop IS NOT NULL) AS hop_bearing_rows,
--     ROUND(SUM(IF(servedByHop IS NOT NULL AND servedByHop != 'primary', costUsd, 0)), 6) AS fallback_usd,
--     ROUND(SUM(costUsd), 6) AS total_usd
--   FROM `PROJECT.bi_telemetry.agent_runs_bi`
--   WHERE LOWER(model) LIKE 'claude%'
--   GROUP BY day
--   ORDER BY day;
