variable "project_id" {
  description = "The GCP project this environment's agent-engine resources live in (karoscmo-prep or karoscmo)."
  type        = string
}

variable "firestore_project_id" {
  description = <<-EOT
    The GCP project holding the Firestore database this environment reads
    (per docs/RFC-01 and cloudbuild.yaml's own comment: Firestore is not
    enabled in karoscmo-prep, so BOTH environments' Firestore lives in
    karoscmo — prep uses the named "prep" database, prod uses "(default)").
    Only used here to grant roles/datastore.user; the database split itself
    is application config (FIRESTORE_DATABASE_ID), not infrastructure.
  EOT
  type        = string
}

variable "region" {
  description = "Primary Cloud Run / Cloud Build region for this environment."
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Short environment tag used only in resource descriptions/labels ('prep' or 'prod') — never in a conditional, since prep and prod are two separate applies of this same configuration, not a fork inside it."
  type        = string
  validation {
    condition     = contains(["prep", "prod"], var.environment)
    error_message = "environment must be \"prep\" or \"prod\"."
  }
}

# ── Runtime service account ─────────────────────────────────────────────────
# One shared SA runs both Cloud Run services (agent-engine-<env> HTTP and
# agent-engine-<env>-worker) — see cloudbuild.yaml's own header comment. This
# config creates it so it is no longer a hand-run `gcloud iam
# service-accounts create` step; see README.md for the required `terraform
# import` before the first apply, since prep and prod's SAs already exist.
variable "runtime_service_account_id" {
  description = "Account id (not full email) for the shared agent-engine runtime service account."
  type        = string
  default     = "agent-engine-sa"
}

# ── Buckets ──────────────────────────────────────────────────────────────────
variable "media_bucket_name" {
  description = "GCS_MEDIA_BUCKET — rendered carousel PNGs / branded-shorts MP4s. Globally unique bucket name."
  type        = string
}

variable "artifacts_bucket_name" {
  description = "GCS_ARTIFACTS_BUCKET — disposable renders and archived step/slot output, served by 7-day signed URLs."
  type        = string
}

variable "workspace_bucket_name" {
  description = <<-EOT
    GCS_WORKSPACE_BUCKET — DEDICATED bucket for durable tenant state (brand
    kits, voice rules, strategy docs, ledgers, memory, topics, reputation
    ledgers). SCRUM-327 / Tomer decision record on SCRUM-333, ruling 14
    (2026-08-28): this must be its own bucket, never the artifacts bucket —
    the two have opposite retention needs, and a lifecycle rule aimed at
    disposable renders would silently delete client business state if they
    shared a bucket.
  EOT
  type        = string
}

variable "bucket_location" {
  description = "GCS bucket location. \"US\" (multi-region) unless there is a reason to pin a single region."
  type        = string
  default     = "US"
}

variable "artifacts_lifecycle_age_days" {
  description = <<-EOT
    Optional: age in days after which an object in the ARTIFACTS bucket
    (never workspace — see the precondition on that resource) is deleted.
    0/null disables the rule. This was not safely settable before SCRUM-327
    because the workspace store shared this bucket; now that it does not,
    turning this on is a deliberate, separate decision for whoever operates
    the bucket, so it defaults to disabled rather than this ticket silently
    picking a retention window.
  EOT
  type        = number
  default     = null
}

# ── Pub/Sub ──────────────────────────────────────────────────────────────────
variable "run_jobs_topic_name" {
  description = "QUEUE_TOPIC_RUN_JOBS — the topic /runs/start publishes to and the worker's pull subscription reads from."
  type        = string
}

variable "run_jobs_subscription_name" {
  description = "QUEUE_SUBSCRIPTION_RUN_JOBS — the PULL subscription apps/agent-server/src/queue-consumer.ts binds to. Confirm this matches the live PREP_QUEUE_SUBSCRIPTION / PROD_QUEUE_SUBSCRIPTION GitHub variable before importing (see README.md) — this repo cannot read that variable's value."
  type        = string
}

variable "run_jobs_ack_deadline_seconds" {
  description = "Matches README.md's documented production ack deadline for the long-running worker (Chromium renders, video)."
  type        = number
  default     = 600
}

variable "dlq_topic_name" {
  description = "Dead-letter topic for the run-jobs pull subscription. Not currently provisioned as code anywhere — this is net-new IaC, not an import target, unless one was hand-created under this exact name."
  type        = string
}

variable "dlq_subscription_name" {
  description = "A pull subscription on the DLQ topic so a dead-lettered message is actually retrievable for inspection/replay, rather than accumulating in a topic nothing reads."
  type        = string
}

variable "dlq_max_delivery_attempts" {
  description = "Delivery attempts on the main subscription before a message is dead-lettered. README.md's old (unused) push-subscription example used 5; kept as the default for continuity, not because it was verified against a running config."
  type        = number
  default     = 5
}

variable "run_jobs_publisher_service_accounts" {
  description = <<-EOT
    Full emails of service accounts (besides the runtime SA itself, which
    always gets publisher+subscriber) that need roles/pubsub.publisher on
    the run-jobs topic — i.e. whoever calls POST /api/v1/runs/start from
    outside this service (karosCMO/Portal). Empty list is valid (e.g. prep,
    where the calling identity may not be established yet) but should not
    stay empty in an environment that is actually receiving enqueues.
  EOT
  type    = list(string)
  default = []
}

# ── Secret Manager accessor bindings ────────────────────────────────────────
variable "secret_accessor_ids" {
  description = <<-EOT
    Secret Manager secret IDs (in this project) the runtime SA needs
    roles/secretmanager.secretAccessor on. Deliberately NOT populated with a
    guessed list here (e.g. "anthropic-api-key") — cloudbuild.yaml /
    cloudbuild.promote.yaml are the authority on which secrets each service
    surface actually mounts, and scripts/config-inventory.ts already checks
    that file against .env.example. Pass the real list per environment in
    envs/*.tfvars once confirmed against the live project — do not paste in
    a name you have not checked against `gcloud secrets list`.
  EOT
  type    = list(string)
  default = []
}
