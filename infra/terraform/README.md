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

```bash
terraform plan  -var-file=envs/prep.tfvars
terraform apply -var-file=envs/prep.tfvars
```

After a clean import, the plan for everything in the "already exists" rows
should show little or no change. The plan for `google_storage_bucket.workspace`,
`google_pubsub_topic.run_jobs_dlq`, and `google_pubsub_subscription.run_jobs_dlq_pull`
will show **create** — that is expected; those are the net-new resources
this ticket adds.

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
