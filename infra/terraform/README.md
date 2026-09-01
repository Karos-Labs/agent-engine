# infra/terraform/ — agent-engine's GCP infrastructure as code

SCRUM-327 (AU43). Puts into code what has been hand-provisioned in
`karoscmo-prep` and `karoscmo`: the runtime service account, the three GCS
buckets, the run-jobs Pub/Sub topic + pull subscription, and (net new) a
dead-letter topic/subscription for it. It does **not** cover Cloud Run
service deployment itself (`cloudbuild.yaml` / `cloudbuild.promote.yaml`
already own that) or the Secret Manager secrets' *values* (never put a
secret value in Terraform state in plaintext — only accessor bindings are
modeled here, and only for secret IDs you list explicitly).

## What this repo could verify vs. what it could not

This was written and reviewed in a sandboxed clone with **no GCP
credentials and no network path to a real project** — every claim below
about what currently exists was checked against this repo's own source
(test fixtures, `cloudbuild.yaml`/`cloudbuild.promote.yaml` substitution
defaults, `.github/workflows/deploy-*.yml`, `README.md`), never against a
live `gcloud` call. `terraform validate`/`plan`/`apply` were **not run** —
this environment has no network path to `releases.hashicorp.com` (confirmed:
outbound `CONNECT` to it returns `403` through the proxy here) or to any GCP
API. Treat the HCL as reviewed-by-reading, not as verified-by-running.

| Resource | Already exists (needs `import`) | Net new (needs `apply`) | Confidence |
|---|---|---|---|
| `google_service_account.agent_engine` | Yes, both envs | — | High — `cloudbuild.yaml`'s own header names the exact `gcloud iam service-accounts create` command already run |
| `google_storage_bucket.media` | Yes, both envs | — | High — exact names appear in this repo's own test fixtures (`capability-report.test.ts`, `gcs-artifact-store.test.ts`) |
| `google_storage_bucket.artifacts` | Yes, both envs | — | High — same fixtures |
| `google_storage_bucket.workspace` | **No** | **Yes** | This is the point of SCRUM-327 / decision 14 — today `GCS_WORKSPACE_BUCKET` is fed the artifacts bucket's name (see the `.github/workflows/deploy-*.yml` diff in this same commit); the bucket named here does not exist yet |
| `google_pubsub_topic.run_jobs` | Yes, both envs | — | High — `karos-agent-runs-prep` / `karos-agent-runs-prod` are the literal cloudbuild substitution defaults |
| `google_pubsub_subscription.run_jobs_pull` | Likely yes, both envs | — | Medium — README.md documents the *shape* ("one PULL subscription, `karos-agent-runs-<env>-pull`") as what is actually deployed, but the exact name lives in the `PREP_QUEUE_SUBSCRIPTION`/`PROD_QUEUE_SUBSCRIPTION` GitHub Actions variables, which this repo cannot read. **Confirm the real name before importing** — see below. |
| `google_pubsub_topic.run_jobs_dlq` + its pull subscription | **No** | **Yes** | This is the ticket's explicit "plus DLQ provisioning in-repo" ask. Nothing in this repo names an existing DLQ topic for the pull subscription — README.md's only DLQ example was for a push-subscription design that "was a design intent and it never shipped" (README.md, "Production: the pull consumer" section). Treat this as genuinely absent, not merely undocumented. |
| IAM bindings (bucket/topic/subscription level) | Mixed | Mixed | Bindings on existing resources are likely already granted by hand (cloudbuild.yaml's setup comment lists the intended roles) but were never captured as code, so `apply` may report some as already-in-place (no-op) and others as new. |

## One-time setup per environment (run by Tomer, against the real project)

```bash
cd infra/terraform
terraform init \
  -backend-config="bucket=<a-state-bucket-you-choose>" \
  -backend-config="prefix=agent-engine/<prep|prod>"
```

No backend is configured in `versions.tf` on purpose — state-bucket choice is
an operational decision for whoever runs this, not something to bake into
source (see that file's comment). Use a **separate state prefix per
environment**; this same configuration is applied twice, once per
`envs/*.tfvars`, never sharing one state file between prep and prod.

### Step 1 — import what already exists

Everything in the first table above marked "needs `import`" must be
imported before the first `plan`/`apply`, or Terraform will try to create a
duplicate and fail (buckets/topics/SAs) — or, worse for a Pub/Sub
subscription, could succeed in a way that produces a second, different
resource under a name collision. Confirm the pull subscription's real name
first:

```bash
gcloud pubsub subscriptions list --project=karoscmo-prep --format='value(name)'
gcloud pubsub subscriptions list --project=karoscmo --format='value(name)'
```

If the real name differs from `karos-agent-runs-<env>-pull`, edit
`envs/<env>.tfvars`'s `run_jobs_subscription_name` to match **before**
running anything else below — importing under the wrong name will not fail
loudly, it will just point Terraform at nothing and then `apply` will try to
create a second subscription.

```bash
# repeat with -var-file=envs/prod.tfvars for the prod project
terraform import -var-file=envs/prep.tfvars \
  google_service_account.agent_engine \
  "projects/karoscmo-prep/serviceAccounts/agent-engine-sa@karoscmo-prep.iam.gserviceaccount.com"

terraform import -var-file=envs/prep.tfvars google_storage_bucket.media karoscmo-prep-media-assets
terraform import -var-file=envs/prep.tfvars google_storage_bucket.artifacts karoscmo-prep-agent-artifacts

terraform import -var-file=envs/prep.tfvars \
  google_pubsub_topic.run_jobs projects/karoscmo-prep/topics/karos-agent-runs-prep

terraform import -var-file=envs/prep.tfvars \
  google_pubsub_subscription.run_jobs_pull projects/karoscmo-prep/subscriptions/karos-agent-runs-prep-pull
```

The existing IAM bindings (SA roles on the project/buckets/topic) may or may
not need explicit import — `google_*_iam_member` resources are additive and
idempotent; running `apply` without importing them typically just confirms
the binding already exists rather than erroring, but review the plan output
before applying regardless (this is exactly the class of thing that should
never be applied unread against production).

### Step 2 — `plan`, read it, then `apply`

**This is the drift check, and it is the one step this session could not
run.** No GCP credentials and no network path out of this sandbox reach a
real project — `terraform init`/`plan`/`apply` were never executed against
`karoscmo-prep` or `karoscmo`, only reviewed by reading. The exact runnable
sequence, unchanged from what a credentialed run needs, is:

```bash
cd infra/terraform
terraform init \
  -backend-config="bucket=<a-state-bucket-you-choose>" \
  -backend-config="prefix=agent-engine/prep"
# repeat import commands from Step 1 for prep, then:
terraform plan  -var-file=envs/prep.tfvars
terraform apply -var-file=envs/prep.tfvars

# separately, with prod's own state prefix:
terraform init \
  -backend-config="bucket=<a-state-bucket-you-choose>" \
  -backend-config="prefix=agent-engine/prod"
# repeat import commands from Step 1 for prod, then:
terraform plan  -var-file=envs/prod.tfvars
terraform apply -var-file=envs/prod.tfvars
```

After a clean import, the plan for everything in the "already exists" rows
should show little or no change. The plan for `google_storage_bucket.workspace`,
`google_pubsub_topic.run_jobs_dlq`, and `google_pubsub_subscription.run_jobs_dlq_pull`
will show **create** — that is expected; those are the net-new resources
this ticket adds.

**Review checklist for whoever runs the two `plan`s above** — read the full
output before `apply`, per environment, and do not apply anything that
surprises you against this list:

1. **Unexpected deletions.** Anything other than the net-new-create three
   resources above showing `-` (destroy) or `-/+` (replace) is a stop-and-
   investigate, not a proceed. A replace on `google_storage_bucket.media` or
   `.artifacts` in particular would mean the import in Step 1 targeted the
   wrong project/name and Terraform now believes the real bucket needs
   recreating — never let that apply.
2. **Resources present in reality but absent from state.** A clean `plan`
   only tells you about resources this config *declares*; it says nothing
   about a bucket, topic, or SA that exists in the project and isn't named
   in any `.tf` file here. That is exactly the `karos-media-assets` and
   `karoscmo-agent-artifacts` gap in the table above — `terraform plan`
   will never surface them because Terraform doesn't know to look. Cross-
   check independently, once credentials exist:
   ```bash
   gcloud storage buckets list --project=karoscmo --format='value(name)'
   gcloud storage buckets list --project=karoscmo-prep --format='value(name)'
   gcloud pubsub topics list --project=karoscmo
   gcloud pubsub subscriptions list --project=karoscmo
   ```
   and diff the result against this file's declared resource names plus the
   table above — anything on neither list is a new, undocumented finding,
   not something this review has already covered.
3. **Drifted IAM bindings.** `google_*_iam_member` resources are additive,
   so `plan` will show `+` for a binding that is already granted by hand
   under a different Terraform-invisible grant path (a group membership, a
   broader project-level role that already covers it) — that shows as a
   no-op `apply`, not a `plan` finding, so it will not raise itself. The
   thing to actually check by hand: `gcloud projects get-iam-policy` /
   `gcloud storage buckets get-iam-policy` / `gcloud pubsub topics
   get-iam-policy` on each resource, and confirm no *extra* principal holds
   a role this config doesn't grant — Terraform only reports what it
   manages, so a stale hand-added grant (an ex-employee's account, a
   debugging binding someone forgot to revoke) will not appear in `plan`
   output at all and needs this separate, manual look.
4. **The pull-subscription name.** Confirmed in Step 1 already, repeated
   here because it's the one import most likely to silently create a
   duplicate rather than failing loudly: if `run_jobs_subscription_name` in
   either `envs/*.tfvars` does not match the live
   `PREP_QUEUE_SUBSCRIPTION`/`PROD_QUEUE_SUBSCRIPTION` GitHub variable
   exactly, `plan` will show a `create` for a subscription that already
   exists under a different name, not an error.

### Step 3 — the workspace bucket migration this creates

Creating the dedicated bucket is not the same as finishing the migration.
Today's `GCS_WORKSPACE_BUCKET` GitHub variable (`PREP_GCS_WORKSPACE_BUCKET` /
`PROD_GCS_WORKSPACE_BUCKET`, wired by this same ticket's change to
`.github/workflows/deploy-*.yml`) does not exist as a repo variable yet, and
the tenant data currently living under the artifacts bucket's prefixes needs
either a one-time copy into the new bucket, or acceptance that the new
bucket starts empty and the old data stays where it is (a real product
decision — this repo cannot make it). Concretely, before the next deploy of
either environment:

1. `terraform apply` creates `karoscmo-<env>-agent-workspace`.
2. Decide and execute the data migration (`gsutil -m cp -r
   gs://karoscmo-<env>-agent-artifacts/<workspace-prefixes>/*
   gs://karoscmo-<env>-agent-workspace/`, once you have confirmed which
   prefixes are workspace data vs. disposable artifacts — this repo does not
   know the prefix convention live data uses).
3. Set the new `PREP_GCS_WORKSPACE_BUCKET` / `PROD_GCS_WORKSPACE_BUCKET`
   GitHub Actions repository variables to the new bucket names.
4. Deploy. `apps/agent-server/__tests__/workspace-store-wiring.test.ts`'s
   "SCRUM-327" describe block will fail the next `npm test` if the workflow
   files ever regress to pointing `_GCS_WORKSPACE_BUCKET` back at the
   artifacts variable.

Skipping step 3 means the deploy workflow's own "Validate required repo
variables" step fails closed (it now requires
`PREP_GCS_WORKSPACE_BUCKET`/`PROD_GCS_WORKSPACE_BUCKET` to be non-empty) —
it does not silently fall back to the old shared bucket.

## Layout

- `versions.tf` — provider requirements, no backend (see above).
- `variables.tf` — every input, with the evidence (or its absence) for each
  default documented inline.
- `service_account.tf` — the shared runtime SA and its project-level IAM
  (`aiplatform.user`, cross-project `datastore.user` on the Firestore
  project, and per-secret `secretmanager.secretAccessor` for whatever
  `secret_accessor_ids` names).
- `storage.tf` — the three buckets. The workspace bucket carries a
  `precondition` that fails `plan`/`apply` outright if its name is ever set
  equal to the artifacts bucket's name — a structural guard for decision 14,
  not just a comment.
- `pubsub.tf` — the run-jobs topic/subscription plus the DLQ topic/
  subscription pair, and the IAM Pub/Sub's own service agent needs to
  deliver dead letters.
- `outputs.tf` — the resource names/emails, useful for wiring back into
  `cloudbuild.yaml`'s substitutions or a GitHub Actions variable by hand.
- `envs/prep.tfvars`, `envs/prod.tfvars` — the concrete values, each
  annotated with what in this repo it was verified against.

## What is deliberately NOT in this config

Hand-provisioned **on purpose**, with the reason written down — this is the
good case, and the distinction from the next section is the entire point of
this ticket:

- **Cloud Run services themselves** — `cloudbuild.yaml` /
  `cloudbuild.promote.yaml` deploy those; duplicating that in Terraform
  would create two sources of truth for the same thing.
- **Secret Manager secret *creation* or values** — only accessor IAM,
  and only for IDs explicitly listed per environment.
- **The Workload Identity Federation trust boundary** for GitHub Actions
  (`deploy-prep.yml`'s own setup comment: "this is an IAM trust-boundary
  change; do it deliberately, not as an automated side effect of a
  deploy") — same reasoning applies to modeling it here.
- **`roles/run.invoker`** grants for Cloud Build's own service account on
  this service — a one-time, already-documented manual step
  (`cloudbuild.yaml`'s header), not part of the buckets/topics/
  subscriptions/DLQs/IAM surface this ticket names.

## Buckets that exist in production and are NOT in this config — the bad case

The three buckets above (`media`, `artifacts`, `workspace`, times two
environments) are every bucket this repo's own source — env vars,
cloudbuild substitutions, test fixtures — names. A prior production-bucket
audit (feeding SCRUM-376/AU74 and this ticket) found three buckets live in
GCP that do not match that list one-for-one.

**Updated 2026-09-01 from a live read** (`gcloud` access was unavailable when
this section was first written; it is available now, and two of the three rows
below were wrong because of it). Both corrections have the same root cause: the
original pass grepped *this repo's* source for a literal bucket name. That misses
a bucket named by a **sibling repo**, and it misses one supplied through a
**Secret Manager reference** rather than a literal `value:` env var. Neither
bucket was ever unowned.

Here is where each one actually stands, because "hand-provisioned and
undocumented" is the failure mode this ticket exists to end, not something to
wave through with the same shrug as the deliberate exclusions above:

| Bucket | In this Terraform config? | Named by any env var in this repo? | Status |
|---|---|---|---|
| `karoscmo-prod-media-assets` | **Yes** — `google_storage_bucket.media` via `envs/prod.tfvars`' `media_bucket_name` | Yes — `GCS_MEDIA_BUCKET` (prod) | Accounted for. Not a gap. |
| `karos-media-assets` | **No.** No `.tf` file, no `envs/*.tfvars` entry, no variable default names it. | **Not in this repo — but named, live, by karosCMO.** It is the portal's own `_GCS_MEDIA_BUCKET` (`karosCMO/cloudbuild.yaml`, `karosCMO/cloudbuild.promote.yaml`), and production's `karos-cmo` Cloud Run service carries `GCS_MEDIA_BUCKET=karos-media-assets` today. | **Accounted for, and NOT the other half of a split-brain.** AU74 is resolved: this is the *portal's* media bucket and `karoscmo-prod-media-assets` is the *engine's*, and they are unrelated pipelines that collide only in the variable's name — the portal stores `clients/<id>/podcast-clips/` and `clients/<id>/run-attachments/` here (15 objects, 104 MiB), the engine stores `instagram/…` carousel renders there (8 objects). The portal never reads the engine's bucket at all (`materialize.ts` re-uploads deliverables fetched over https into Firebase Storage and skips bare `gs://` URIs). **Still do not add it to this Terraform config** — it belongs to karosCMO, not to agent-engine, and modelling another repo's bucket here would be the same "silently imported" mistake in a new direction. |
| `karoscmo-agent-artifacts` (no `-prep-`/`-prod-` in the name — distinct from `karoscmo-prep-agent-artifacts` and `karoscmo-prod-agent-artifacts`, both of which **are** declared above) | **No.** | **Yes — through a Secret Manager reference, which is why the grep missed it.** `agent-service-api` and `agent-service-worker` (karoscmo, europe-west1) run with `ARTIFACT_STORE=gcs` and `AGENT_ARTIFACTS_BUCKET` bound to `secretKeyRef: agent-artifacts-bucket`; that secret's value is `karoscmo-agent-artifacts`. | **NOT orphaned. This is a live production artifact store — do not delete it.** The earlier "nothing names it" conclusion came from scanning literal env-var values, which cannot see a `secretKeyRef`. IAM corroborates ownership independently: `agent-service-sa@karoscmo` and `agent-runner-sa@karoscmo` both hold `roles/storage.objectAdmin` on it. Contents are `artifacts/<uuid>/` and `transcripts/<uuid>.jsonl` (the transcripts prefix alone is 1,351 objects); last write 2026-08-10. It is owned by **agent-service**, not by this repo, so it still does not belong in this Terraform config — but it is accounted for, and the human decision this row used to ask for has been answered. |

Put plainly, after the live read: all three are accounted for, and none of the
three belongs in this config. One is declared here already; the other two are
owned by sibling services (karosCMO and agent-service respectively) that name
them in their own deploy configuration. Importing another repo's bucket into
`storage.tf` would just convert "owned elsewhere" into "owned twice," which is
not a fix. They stay listed here, by name and with the evidence, so the next
person does not have to re-run the audit to know they exist — and so that no one
acts on the previous version of this table, which invited deleting
`karoscmo-agent-artifacts` "after confirming nothing depends on it" while two
production services were actively depending on it.
