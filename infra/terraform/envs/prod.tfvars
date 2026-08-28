# Values verified against this repo's own source (test fixtures, cloudbuild
# substitution defaults, GitHub workflow substitution strings) as of
# 2026-08-28 — see infra/terraform/README.md for exactly what each one is
# grounded in and what still needs live confirmation before `apply`.

project_id            = "karoscmo"
firestore_project_id  = "karoscmo"
region                = "us-central1"
environment            = "prod"

media_bucket_name      = "karoscmo-prod-media-assets"
artifacts_bucket_name  = "karoscmo-prod-agent-artifacts"
workspace_bucket_name  = "karoscmo-prod-agent-workspace" # NEW — see storage.tf

run_jobs_topic_name        = "karos-agent-runs-prod"
run_jobs_subscription_name = "karos-agent-runs-prod-pull" # CONFIRM against the live PROD_QUEUE_SUBSCRIPTION GitHub variable before import
dlq_topic_name              = "karos-agent-runs-prod-dlq"
dlq_subscription_name       = "karos-agent-runs-prod-dlq-pull"

# The portal's runtime SA — confirmed from cloudbuild.promote.yaml's
# _AUTH_ALLOWED_SERVICE_ACCOUNTS substitution default, which names this exact
# identity as the one real caller of agent-engine-prod (established by
# reading live Cloud Run runtime identities, per that file's own comment).
run_jobs_publisher_service_accounts = [
  "firebase-adminsdk-fbsvc@karoscmo.iam.gserviceaccount.com",
]

# Populate once confirmed against `gcloud secrets list --project=karoscmo`.
# cloudbuild.promote.yaml wires anthropic-api-key and scrappycoco-api-key
# only — UNSPLASH/PEXELS/PIXABAY/GOOGLE_PLACES are deliberately prep-only
# (documented in cloudbuild.yaml's own comments; do not add them here without
# re-reading that reasoning).
secret_accessor_ids = []
