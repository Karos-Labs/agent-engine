# Values verified against this repo's own source (test fixtures, cloudbuild
# substitution defaults, GitHub workflow substitution strings) as of
# 2026-08-28 — see infra/terraform/README.md for exactly what each one is
# grounded in and what still needs live confirmation before `apply`.

project_id            = "karoscmo-prep"
firestore_project_id  = "karoscmo" # Firestore not enabled in karoscmo-prep itself; see cloudbuild.yaml's own comment
region                = "us-central1"
environment            = "prep"

media_bucket_name      = "karoscmo-prep-media-assets"
artifacts_bucket_name  = "karoscmo-prep-agent-artifacts"
workspace_bucket_name  = "karoscmo-prep-agent-workspace" # NEW — see storage.tf

run_jobs_topic_name        = "karos-agent-runs-prep"
run_jobs_subscription_name = "karos-agent-runs-prep-pull" # CONFIRM against the live PREP_QUEUE_SUBSCRIPTION GitHub variable before import
dlq_topic_name              = "karos-agent-runs-prep-dlq"
dlq_subscription_name       = "karos-agent-runs-prep-dlq-pull"

# No external caller identity established for prep in this repo's own
# config — leave empty until one is confirmed (unlike prod, whose
# cloudbuild.promote.yaml already names karosCMO's runtime SA explicitly).
run_jobs_publisher_service_accounts = []

# Populate once confirmed against `gcloud secrets list --project=karoscmo-prep`.
# cloudbuild.yaml wires anthropic-api-key, unsplash-access-key,
# pexels-api-key, pixabay-api-key, google-places-key, scrappycoco-api-key —
# but "wired in cloudbuild" and "granted secretAccessor via IAC" are two
# different facts, and only the former is verified from source here.
secret_accessor_ids = []
