# The shared runtime service account for both Cloud Run services
# (agent-engine-<env> HTTP and agent-engine-<env>-worker). Currently created
# by hand per cloudbuild.yaml's own header comment:
#
#   gcloud iam service-accounts create agent-engine-sa --project=<project> \
#     --display-name="Agent engine (api+worker)"
#
# This resource models that so it stops being a step only reproducible by
# whoever remembers to run it. It ALREADY EXISTS in both karoscmo-prep and
# karoscmo — see README.md for the `terraform import` this needs before the
# first `apply`, or this resource will try (and fail) to create a duplicate.
resource "google_service_account" "agent_engine" {
  project      = var.project_id
  account_id   = var.runtime_service_account_id
  display_name = "Agent engine (api+worker)"
}

# roles/aiplatform.user — Vertex AI (model calls, including the direct
# Anthropic-on-Vertex fallback hop that SCRUM-333 decision 11 makes permanent
# production architecture).
resource "google_project_iam_member" "agent_engine_aiplatform_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.agent_engine.email}"
}

# roles/datastore.user — on the FIRESTORE project, which for BOTH
# environments is karoscmo (see variables.tf's firestore_project_id doc).
# This is a cross-project binding by design when var.project_id is
# karoscmo-prep.
resource "google_project_iam_member" "agent_engine_datastore_user" {
  project = var.firestore_project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.agent_engine.email}"
}

# roles/secretmanager.secretAccessor — resource-scoped, never project-wide,
# and only for secrets this environment's tfvars actually lists (see
# variables.tf's secret_accessor_ids doc for why nothing is guessed here).
resource "google_secret_manager_secret_iam_member" "agent_engine_secret_accessor" {
  for_each  = toset(var.secret_accessor_ids)
  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agent_engine.email}"
}
