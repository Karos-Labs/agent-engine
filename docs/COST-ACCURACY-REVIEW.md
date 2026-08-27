# Cost accuracy: the recurring review

**Owner:** Tomer · **Cadence:** monthly, and before any change to how a model or media unit is billed · **Ticket:** the per-unit cost work — shipped without a Jira ticket

## Why this exists

A measured Instagram run (`pubsub-21560857620229716`, prep, 2026-08-26) reported
**$0.565829**. Its true cost was about **$0.644** — a **~14% understatement**.

Two things about that number matter more than its size.

**It was not a wrong calculation.** `image.generate` is a *tool*, and no tool had
a cost path at all: `AgentToolOutcome` had nowhere to put one, and `runStepCode`
wrote the literal constant `0`. The run reported a total that summed exactly,
reconciled against BigQuery, and was internally consistent — and was missing a
whole category of spend.

**A structural gap tells you a number is wrong. It never tells you how wrong.**
The hypothesis going in was $1.50–4 per run. The measurement said $0.644. The
estimate was off by 3–4×, in the direction of alarm rather than complacency, and
it was wrong because the unit price was right and the *volume* was invented.

So this review's job is not to confirm the numbers. It is to be capable of
saying they are wrong.

## The three instruments

Each catches something the others structurally cannot.

| | What it checks | When it fails | Where |
|---|---|---|---|
| **1. `check:pricing`** | Every model id named in executable source has a price row | Before deploy, in CI | `scripts/check-model-pricing.ts` |
| **2. Golden run + metered-tool guard** | Cost mixes tokens *and* per-unit media; every tool that calls a metered API reports what it consumed | On every test run | `packages/workflow/__tests__/cost-accuracy-golden.test.ts` |
| **3. This review** | Our table still matches what the vendor actually charges | Monthly, by a human | this document |

1 and 2 are regression guards: they hold the system to what we already know. **3
is the only one that can discover we were wrong all along**, because it compares
our numbers to something outside the repo. Neither of the others can do that; a
test can only ever assert what someone already believed.

Both automated guards have been observed **refusing** — not merely passing.
`check:pricing` found `gemini-1.5-flash` (the failover target, unpriced,
overstating ~40×) on its first run, and reported `claude-opus-5` from a doc
comment, which is why it now strips comments before scanning. The metered-tool
guard was verified by deleting `image.generate`'s `usage` and watching it fail.

## The procedure

### Step 1 — pull one completed run

```bash
gcloud auth print-access-token
```

Then read the run and its steps from Firestore (project `karoscmo`, database
`prep` or `(default)`, collection `agentEngineRuns`). Record `totalCostUsd` and
every step's `costUsd` and `unitUsage`.

### Step 2 — reconcile the token half against BigQuery

```sql
SELECT model, COUNT(*) turns, SUM(inputTokens) inTok, SUM(outputTokens) outTok, ROUND(SUM(costUsd), 6) cost
FROM `karoscmo-prep.bi_telemetry.agent_runs_bi`
WHERE runId = '<run id>'
GROUP BY model
```

This is a genuinely independent sink, written by a different code path. It
agreeing with Firestore is worth something. **It agreeing does not mean the
number is right** — both were $0.565829 for the run above, and both were missing
the same $0.078 of images.

### Step 3 — reconcile the media half against the vendor

This is the step that can actually fail, and the only one that leaves the repo.

Vertex publisher metrics, for the run's own window:

```bash
gcloud monitoring time-series list \
  --project=karoscmo-prep \
  --filter='metric.type="aiplatform.googleapis.com/publisher/online_serving/model_invocation_count"' \
  --interval-start-time=<run start> --interval-end-time=<run end>
```

Compare the invocation count to the `unitUsage` quantities on the run's steps.
They must match. If they do not, either a tool is under-reporting what it
consumed, or something is spending money outside a tool.

### Step 4 — spot-check two rates against the vendor's published page

Pick two rows from `MODEL_PRICING` or `UNIT_PRICING` and check them against the
vendor's current pricing page. Rotate which two. Every row carries a `source`
field naming where its number came from; if a source no longer says what it did,
that is a finding, and the row's date should move.

### Step 5 — write down what you found

Even "all four matched" — with the run id, the date, and the two rates checked.
A review whose only output is silence cannot be distinguished later from a
review that did not happen.

## Known gaps, stated so they are not rediscovered

**Cache writes are billed at 1×, not 1.25×.** `messages-api-adapter.ts:135,148`
folds `cache_creation_input_tokens` into `uncached`. Anthropic charges a premium
on cache writes, so every run understates slightly.

The awkward part: **this error cannot be measured from our own telemetry**,
because the code that makes it also discards what you would need. Firestore
stores `costUsd` and no token counts at all; BigQuery merges cached and uncached
input into one `inputTokens` column. For the measured run the ceiling is
**$0.065** (87,233 input tokens × 25% × $3/1M, assuming *every* input token were
a cache write — realistically well under half that).

**Declined image generations are unbilled here.** `image.generate` reports
`candidates.length` — images actually produced. An attempt the model declines
returns no image and is not charged the image rate, but its prompt still costs
input tokens that no step records.

**`veo-2.0-generate-001` has no price.** Deliberate: no per-second rate for that
exact id could be verified against a page actually read. The video line is
UNRUNNABLE pending SCRUM-362, so nothing bills through it today, and
`check:pricing` prints it loudly on every run. Needs a decision, not a guess.

## What would make this review pointless

If it becomes a monthly ritual that always says "matched", it has stopped being
a measurement. Two things keep it honest: step 3 leaves the repo and can
contradict us, and step 5 makes a silent review indistinguishable from an absent
one — which it should be.

## Observability that exists outside this repo

Created by hand, so recorded here — none of it is in version control, and the
next person to look will otherwise assume it does not exist.

### `model_failover` log-based metric (SCRUM-360 acceptance 2)

Created in **both** `karoscmo` and `karoscmo-prep`:

```bash
gcloud logging metrics create model_failover   --description="ResilientClaudeAdapter failover events"   --log-filter='jsonPayload.event="model.failover"'
```

It counts the stable `event` string rather than message text, so it survives a
wording change. This is the only rate signal for the Claude path — see below.

### Claude on Vertex is unmetered by Google (SCRUM-361)

`@anthropic-ai/vertex-sdk/client.js:194` issues `rawPredict` /
`streamRawPredict`, not the standard publisher `predict` path. The
`publisher/online_serving/*` metric series are populated from the standard path
only, so **Claude does not appear in them at all** — confirmed against a
production window where our own rows prove the calls happened.

Quota metrics are equally blind: `serviceruntime.googleapis.com/quota/exceeded`
returned zero series over 7 days while `model.failover` logged 11 real 429s.

Practical consequence: `agent_runs_bi` and the failover metric are not the best
signals for the Claude path, they are the ONLY ones. Treat them as primary
instruments.

### The telemetry sink can now be checked without grepping logs

`GET /api/v1/diagnostics/capabilities` returns a `telemetrySink` block
(`attempted` / `succeeded` / `failed` / `lastError`). Production wrote **zero**
rows for its entire life before SCRUM-372, because the runtime SA had no grant
on the dataset and every denial was swallowed. If `failed` is climbing and
`succeeded` is zero, that is the same failure recurring.

### Billing reconciliation is still blocked

`billing_export` exists as a dataset with **no tables** in both projects, and
the two bill to different accounts (`01CD98-A99719-71B855`,
`01DD27-5303C6-631391`). Until the Cloud Billing BigQuery export is enabled in
the Console — it cannot be enabled by API — step 3 of the review above cannot
run, and every engine cost figure remains unreconciled against reality.
