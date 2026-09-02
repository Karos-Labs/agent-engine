# SCRUM-333 / AU50 — production parity ledger

**Standing ticket. Does not close.** Set by Tomer on 2026-08-26: a ticket reaching Prep (merged to
`main`, deployed to the prep project) is not the same claim as a ticket being live in production —
secrets, IAM bindings, `cloudbuild.promote.yaml` env/`--set-secrets`, cross-service config
agreement, and per-environment bucket/topic/subscription names are a second, separate checklist
that a green deploy does not verify. This ledger is where that second checklist lives, so a gap is
a row here instead of a surprise in production.

**This is the ledger's first committed version.** It has been carried as a standing ticket since
Batch 8 (2026-08-26) across every batch plan since, but no prior pass ever landed it as a document
in a repo — this pass does that for the first time, covering everything shipped through Batch 12.
It is deliberately not exhaustive per-ticket for every one of the ~50 tickets batches 1–12 have
shipped (that would need a dedicated follow-on pass reading every ticket's own production
footprint); it records what is actually known today, marks what is unknown as unknown rather than
leaving it blank, and gives the next pass a real structure to extend rather than a blank page.

Every row answers, or explicitly marks unknown, AU50's five production questions:

1. **Secrets** — exists in `karoscmo` (prod), not only the prep project?
2. **IAM** — does the runtime SA hold the binding it needs on that secret/bucket?
3. **`cloudbuild.promote.yaml`** — env vars / `--set-secrets` updated, per service (`deploy-http` and
   `deploy-worker` are separate surfaces).
4. **Cross-service config** — engine and portal's matching `AGENT_ENGINE_*`/equivalent variables
   agree, in the same environment.
5. **Buckets/topics/subscriptions** — named per environment; prod names are usually different from
   prep's.

## Part 1 — open parity rows with known owners (Pass 2 carried forward)

| Row | From | Q1 secret | Q2 IAM | Q3 cloudbuild | Q4 cross-service | Q5 naming | State |
|---|---|---|---|---|---|---|---|
| `PUBSUB_PUSH_TOKEN` unwired in both environments | SCRUM-288 | unknown | unknown | not updated | n/a | n/a | **Still open.** No batch through 12 has touched this. |
| Prep's portal authenticated with a **production** Firebase credential | SCRUM-359 (AU60) | n/a | n/a | n/a | n/a | n/a | **Resolved.** `karosCMO@1026122` ("AU60 (SCRUM-359) Q1") bound the Firestore database id to `GOOGLE_CLOUD_PROJECT` rather than the credential's own `project_id` — probed directly: prep writes land in `databases/prep`, read back NOT_FOUND in `(default)`. Prep does not write to production. Remaining: a dedicated prep-scoped Firebase Admin SA + key, and rotating the production key — those are the still-open parity work, not the incident risk itself. |
| Prep runtime SA has no binding on either prep bucket, media dead at request time | SCRUM-369 (AU69) | n/a | **Now IAM-plan-valid.** | unknown | n/a | n/a | **Q2 pre-condition landed, grant itself not confirmed applied.** SCRUM-373 (found independently, not on any batch doc — landed in both repos) migrated GCS clients from the shared `FIREBASE_SERVICE_ACCOUNT_KEY` credential to pure ADC, so GCS calls now genuinely run as the real per-environment SA (`karos-cmo-prep@karoscmo-prep.iam.gserviceaccount.com` / `karos-cmo-sa@karoscmo.iam.gserviceaccount.com`) instead of the shared prod identity — this is what makes AU69's IAM grant plan meaningful at all; before SCRUM-373 it would have been a no-op. Batch 11 (SCRUM-369) is "treated as done per instruction" per the closing plan, but this environment never independently verified the grant was actually applied in the console — **flag for a live check.** |
| Prod portal and prod engine name **different** media buckets | SCRUM-376 (AU74) | n/a | n/a | n/a | n/a | **Still undecided.** | Batch 11 (SCRUM-376) "treated as done at instruction" — briefing + execution packet delivered, bucket choice itself is a decision for whoever runs the console step, not resolved by this programme. |
| `karoscmo-agent-artifacts` — 12,011 objects / 7.96 GiB named by no variable on any running service | SCRUM-376 | n/a | n/a | n/a | n/a | **Uninventoried.** | Unchanged since Batch 8. No batch through 12 inventories or claims this bucket. |
| Most production Claude spend is invoiced by Anthropic and appears in no GCP report | SCRUM-375 (AU73) | n/a | n/a | n/a | n/a | n/a | **Org not identified.** Unchanged since Batch 8; Batch 11 (SCRUM-375) "treated as done at instruction" per the closing plan but this is an observation/runbook item, not a resolution of the underlying gap. |
| `UNIT_PRICING` has no row for `gemini-2.5-flash`, AU37's vision analysis records $0 | Batch 1/4 finding | n/a | n/a | n/a | n/a | n/a | **Resolved this batch (SCRUM-391, Batch 12).** Investigated which pricing shape was correct (token-based, off the existing `MODEL_PRICING["gemini-2.5-flash"]` row, not a new flat per-call `UNIT_PRICING` guess) and wired real captured token counts through it. Independently re-verified: `npx tsx scripts/check-model-pricing.ts` clean, adversarial-proof reproduced. The capability's cost reporting is no longer a $0 blind spot — this row can close. |
| SCRUM-232/T-A6's gated connector config not applied — needs three decisions, one from an unidentified "Daniel" | Batch 1/4 finding | n/a | n/a | n/a | n/a | n/a | **Still open, and now doubly parked.** SCRUM-390 (Batch 12) confirmed the same "Daniel" sign-off — no surname or handle for "Daniel" appears anywhere in either repository — separately blocks SCRUM-390's own N/N_e denominator field (resolved this round via AU28/SCRUM-319's data-based answer, so SCRUM-390 did not actually need Daniel) and still blocks SCRUM-232's gated config edit. Two independent pieces of work parked on one unidentified person — worth surfacing to Tomer directly as its own question, not folded into either ticket's diff. |

## Part 2 — Batch 11's five console/ops rows (each closes with an observation, not a deploy)

Per `BATCH-11-OPS-RUNBOOK.md` §7 (delivered in the Batch 10/11 handoff) and the closing plan's own
framing ("Batch 11's five console tickets are treated as done here at your instruction"). This
environment cannot independently verify any of these five (no GCP credentials/tooling of any kind,
confirmed repeatedly) — recorded here as the parity rows they are, each flagged with what
independent confirmation would need to check:

| Ticket | What it grants/observes | Independently confirmed by this programme? |
|---|---|---|
| SCRUM-331 | (console action — see runbook) | Not independently confirmed. Execution packet delivered; no live check performed. |
| SCRUM-359 (AU60) | Q1 Firestore-database-binding incident check | **Q1 answer independently corroborated this round** by reading the landed code and commit (see Part 1 row above) — the *code fix* is real and tested; whether it is *deployed and observed working in prep* has not been independently checked live. |
| SCRUM-369 (AU69) | IAM grant on prep bucket | Not independently confirmed the grant itself was applied — see Part 1 row. |
| SCRUM-375 (AU73) | Anthropic spend org identification | Not independently confirmed. |
| SCRUM-376 (AU74) | Prod bucket naming decision | Not independently confirmed — and the closing plan itself notes the bucket choice is still undecided. |

**Recommendation:** the one item worth a live re-check ahead of the others is SCRUM-359, per the
closing plan's own flag — its Q1 "may be an incident rather than a hygiene item and nothing
downstream will surface it" if the fix were not actually deployed to prep.

## Part 3 — systemic gaps found during independent verification, not yet ticketed as parity rows

- **`SEO_GEO_VISIBILITY_ENGINES`'s engine list disagrees with the v2 skill's own current, decided
  engine list** — found during SCRUM-234's confirmation pass this round (see
  `SCRUM-234-audit-4c-confirmation.md` in this same handoff). agent-engine ships `["chatgpt",
  "perplexity", "gemini", "claude", "copilot"]`; the v2 skill's current authority
  (`references/capture-contract.md`, decided 2026-08-19) is `chatgpt, perplexity, gemini, copilot,
  aimode, google_aio` — Claude deferred, `aimode`/`google_aio` live. Not a deploy-parity gap in
  AU50's five-question sense, but a real production-facing correctness risk for whoever builds
  `research.captureVisibility`'s real adapters (§4c's own next recommendation) — recorded here so
  it is not lost before that work is scheduled.
- **Batch 11's console tickets have no independent verification path from this environment at
  all** — worth naming as a standing constraint of this programme's ledger, not just a one-time
  note: every future console/IAM/Secret-Manager ticket will land in this same "treated as done at
  instruction, not independently confirmed" state unless a session with real GCP access performs a
  dedicated verification pass.

## Part 4 — what a complete Pass 1 (per-Prep-ticket) still needs

This version does not attempt a per-ticket Pass 1 across all ~50 tickets at Prep from batches 1–12
— that is real, dedicated work (an hour or more of reading each ticket's own production footprint)
and was not done here in favor of landing Parts 1–3, which carry higher-value, already-known gaps.
**Next pass should:** enumerate every ticket currently at Prep across both repos (a Jira export or
board read, not a guess), and for each one new since this ledger's last update, answer the five
questions above or mark them explicitly unknown. AU50 stays open — that is what a standing ticket
does.

## Part 5 — SCRUM-331 (AU48) production promotion, 2026-09-02

Recorded per the runbook's Stage E. Every row below was **read live**, not inferred from a board
column. The pre-flight write-up, including three deploy-time landmines the runbook does not name, is
`batch-15-handoff-2026-09-02/BATCH-16-PREFLIGHT-HALTED.md`.

### 5.1 Project naming — the runbook is wrong throughout

**Production is `karoscmo`, region `europe-west1`.** There is no `karoscmo-prod`; the only Karos
projects are `karoscmo-prep`, `karoscmo`, `karos-cmo-dev`, `karos-ac05b`. Every command in the
SCRUM-331 runbook carrying `--project=karoscmo-prod` fails on an unknown project, which is also
proof the runbook had never been executed.

Related: its 0.2 permission loop tests `storage.buckets.getIamPolicy`/`setIamPolicy` at **project**
scope, where both come back MISSING and the gate exits 1. Bucket IAM is per bucket; tested at the
right scope all four audited buckets grant both. The gate was failing for the wrong reason.

### 5.2 AUTH_ENABLED — prep ON, production still OFF

| | Value | Where it is pinned |
|---|---|---|
| `agent-engine-prep` | **`true`** (live, verified on the service) | `cloudbuild.yaml`, literal |
| `agent-engine-prod` | `false` | `cloudbuild.promote.yaml`, literal |
| both workers | *(absent, and correct)* | — |

Pinned as literals, never substitutions, per both cloudbuilds' own instruction that the value must
not be able to arrive from outside the file. **Not** flipped with `gcloud run services update` as
the runbook says: both deploy paths use `--set-env-vars`, which REPLACES the environment, so a
hand-flipped flag reverts on the next deploy — enforcement that comes and goes with unrelated
commits.

The worker surfaces have no `AUTH_*` variables and need none: every Pub/Sub subscription in both
projects has an empty `pushConfig` (they are `-pull`), so there is no inbound HTTP to authenticate.
The runbook's "deploy-http **and** deploy-worker" instruction is a no-op on the worker.

### 5.3 AUTH_AUDIENCE and the allowlist — one already done, one retargeted

`AUTH_AUDIENCE` in production was **already set and byte-identical** to `status.url`
(`https://agent-engine-prod-zc6vfwnzsq-ew.a.run.app`). The runbook's "Not defined / Unset" row and
its Stage C capture-and-set step were both stale; nothing to do.

`AUTH_ALLOWED_SERVICE_ACCOUNTS` **changed**, and this was the find that mattered:

- It named `firebase-adminsdk-fbsvc@karoscmo` — the prod portal's runtime identity at the time.
- karos-portal's `cloudbuild.promote.yaml` carries
  `_RUNTIME_SERVICE_ACCOUNT: karos-cmo-sa@karoscmo` as its **default**, and the promote workflow
  passes only 8 substitutions — that is not one of them. **So the portal promotion performs AU58 /
  SCRUM-357 as a side effect.** Confirmed after promoting: the prod portal now runs as
  `karos-cmo-sa@karoscmo` (revision `karos-cmo-00159-t4f`).
- Enforcement plus the old value would therefore have 401'd every portal call.

Retargeted to `karos-cmo-sa@karoscmo` — one entry, the live runtime identity, keeping the file's own
method. **Not** widened to two: the value travels through `--set-env-vars=`, whose own delimiter is
`,`, so a second entry yields a malformed env-var list rather than a two-element allowlist. A test
already enforces that. Two accounts would need gcloud's alternate-delimiter form.

Verified before the change, because the obvious check misleads: `karos-cmo-sa`'s **project-level**
roles are only `aiplatform.user` and `logging.logWriter`, which reads like an SA that cannot mount
the portal's secrets. Checked **per secret** instead — all **30** mounted secrets already grant it,
and it already held `run.invoker` on the engine. AU58's groundwork was complete; only the switch had
never been made.

### 5.4 Bucket mappings — audited, and one violation fixed

| Service | Variable | Value |
|---|---|---|
| prod engine (before) | `GCS_WORKSPACE_BUCKET` | `karoscmo-prod-agent-artifacts` ← **same as artifacts** |
| prod engine (after promotion) | `GCS_WORKSPACE_BUCKET` | `karoscmo-prod-agent-workspace` |
| prod engine | `GCS_ARTIFACTS_BUCKET` | `karoscmo-prod-agent-artifacts` |
| prod engine | `GCS_MEDIA_BUCKET` | `karoscmo-prod-media-assets` |
| prod portal | `GCS_MEDIA_BUCKET` | `karos-media-assets` |
| prod portal | `AGENT_ENGINE_WORKSPACE_BUCKET` | *(empty — see 5.6)* |

Production had the workspace and the disposable-artifacts bucket **pointed at the same bucket**,
which SCRUM-327 / decision 14 forbids: they "must never share a bucket, and therefore never share a
lifecycle/retention policy."

**And the promotion was armed to fix it destructively.** `PROD_GCS_WORKSPACE_BUCKET` was already set
to `karoscmo-prod-agent-workspace` (2026-08-29) and `deploy-prod.yml` applies it — but that bucket
was **empty** while the shared one held **47 objects of live workspace context for all seven
clients**. Prep was migrated on 2026-08-29; prod's variable was set the same day and the data never
moved, leaving it armed for four days. Promoting as written would have made every production client
look to the engine like a client with no context.

Migrated first: 47 objects copied artifacts → workspace, verified by **md5 of every object** (47/47
present, 0 mismatches, 0 extra, 122,090 bytes both sides, per-client distribution identical —
`karoslabs` 23, the other six 4 each). The source is untouched and remains the rollback.

Media buckets confirmed **not** cross-wired, as the runbook asks: portal `karos-media-assets`,
engine `karoscmo-prod-media-assets`.

### 5.5 Buckets deleted

`gs://karoscmo-prod-workspace` and `gs://karoscmo-prep-workspace` — both empty, both unreferenced by
any config, both leftovers of the SCRUM-327 naming superseded by `*-agent-workspace`.

Deliberately **kept**, because they hold data and deleting them is a retention decision:
`karoscmo-agent-artifacts` (1000+ objects / 654 MB of legacy agent-service client outputs and
ledgers), `karoscmo-firestore-migration` (18 objects — a production Firestore export, i.e. a
backup), `karoscmo-agent-service-build-staging` (14 objects / 549 MB of Cloud Build provenance for
the now-deleted agent-service).

### 5.6 Two rows this pass opened rather than closed

**The portal's workspace writer has no access to the workspace bucket.** Only `agent-engine-sa` holds
`roles/storage.objectAdmin` on either `*-agent-workspace` bucket. The prep portal writes to
`karoscmo-prep-agent-artifacts` with `roles/storage.objectCreator` — **create but not delete** — and
`workspace-writer.ts` deletes by design so "anything deleted on this side disappears on the next tick
rather than lingering." Observed live during this pass, from a real reconcile call:

```
error: karos-cmo-prep@karoscmo-prep.iam.gserviceaccount.com does not have
       storage.objects.delete access to the Google Cloud Storage object.
```

repeated per client. So prep's knowledge sync is **failing today**, and it is writing to a bucket the
engine does not read — the engine reads `karoscmo-prep-agent-workspace` (368 live objects, newest
today) while the portal writes to `karoscmo-prep-agent-artifacts` (346 objects, frozen at
2026-08-27, the split date). Two snapshots of the same clients.

The fix is an IAM grant plus repointing the portal, in that order:

```bash
gcloud storage buckets add-iam-policy-binding gs://karoscmo-prep-agent-workspace \
  --member=serviceAccount:karos-cmo-prep@karoscmo-prep.iam.gserviceaccount.com \
  --role=roles/storage.objectAdmin --project=karoscmo-prep
```

then change `deploy-prep.yml`'s hardcoded fallback from `karoscmo-prep-agent-artifacts` to
`karoscmo-prep-agent-workspace`. Repointing without the grant converts a silently-misdirected sync
into a loudly-failing one. Production's is empty, so the sync is simply off there and this promotion
does not regress it — but the same grant will be needed for whichever SA the prod portal runs as
before it can be turned on.

**`AUTH_ENABLED=true` in production is not yet recorded here**, deliberately. The engine's HTTP
surface is genuinely idle in both environments — dispatch goes over Pub/Sub, and the portal only
calls the engine for gate resolution and unmaterialized-deliverable fetches. Two real reconcile
calls (one prep, one prod) produced **no engine HTTP request at all**, because
`materializeAgentEngineDeliverable` returns before the fetch for a product with no materializer
entry. That is reassuring for blast radius — 401s under enforcement would be confined to gate
approvals and materialization, both user-triggered and immediately visible — but it means no
*successful authenticated request* has been observed since enforcement went on. That observation is
the last thing this row needs before it can be called closed.

### 5.7 Default compute invoker (§3.1's decision) — answered by the facts

- **Production: nothing to remove.** `agent-engine-prod`'s invoker list is
  `firebase-adminsdk-fbsvc@karoscmo`, `karos-cmo-sa@karoscmo`, `user:hello@karoslabs.com` — no
  default compute. The one prod service running as default compute is `landing-page`, and it is
  already not an engine invoker.
- **Prep: present and safe to remove.** `680337539054-compute@developer` is in
  `agent-engine-prep`'s invoker list, and all four prep services run under dedicated service
  accounts, so nothing depends on it. Not yet removed.

### 5.8 Commits and promotions

| Item | SHA / run |
|---|---|
| Batch 15 engine (SCRUM-396, SCRUM-234) | `3d6637f`, `9278630` |
| AU11 drift-check fix (saw 0 of 88 tools) | `8cfc93d` |
| Stage A — prep enforcement ON | `b9e5032` |
| Prod allowlist retargeted to `karos-cmo-sa` | `ff20db2` |
| Batch 15 portal (SCRUM-404, SCRUM-276) | karos-portal `0fef40aa` (PR #75) |
| **Portal → production** | run `33676535725`, **success**; prod now `0fef40aa`, SA `karos-cmo-sa` |

Portal production health after promotion: `/` 307 → `/login` 200, **zero 5xx** in the following ten
minutes. SCRUM-330's fail-open fix is now in production, which is what unblocked SCRUM-331 there —
prod's previous image `6a76387b` (2026-08-24, 118 commits behind) did not contain it.

`cloudbuild.promote.yaml` does not rebuild: it re-tags the **prep-tagged image by SHA**, so
production runs the byte-identical image prep ran. Promote the SHA verified in prep, never "latest
main".

## Sources

- `agent-engine/docs/AUDIT-2026-08-25-architecture-optimization-plan.md`
- `BATCH-8-HOUSEKEEPING-AND-LEDGER.md` (this ledger's original spec and the five-question framework)
- `karosCMO@1026122` (AU60/SCRUM-359's fix commit, read directly)
- `agent-engine`/`karosCMO` diffs for SCRUM-373 (GCS ADC migration), read directly
- This round's own SCRUM-390 (Batch 12) and SCRUM-234 (Batch 12) findings
- `BATCH-11-OPS-RUNBOOK.md` §7 (delivered Batch 10/11 handoff)
- SCRUM-331 (AU48) pre-flight + execution, 2026-09-02 — every row in Part 5 read live from
  Cloud Run, Cloud Storage, Secret Manager, Pub/Sub and Firestore in both projects
