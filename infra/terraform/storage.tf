# Three buckets. media and artifacts already exist by hand in both
# environments (karoscmo-prep-media-assets / karoscmo-prep-agent-artifacts /
# karoscmo-prod-media-assets / karoscmo-prod-agent-artifacts — names verified
# against this repo's own test fixtures, e.g.
# apps/agent-server/__tests__/capability-report.test.ts and
# packages/tools/common/__tests__/gcs-artifact-store.test.ts). The workspace
# bucket is NET NEW — SCRUM-327 / decision 14 stops it from sharing the
# artifacts bucket. See README.md for which resources need `terraform
# import` and which need a real `apply` to create something new.

resource "google_storage_bucket" "media" {
  project                     = var.project_id
  name                        = var.media_bucket_name
  location                    = var.bucket_location
  uniform_bucket_level_access = true
  force_destroy               = false
}

resource "google_storage_bucket" "artifacts" {
  project                     = var.project_id
  name                        = var.artifacts_bucket_name
  location                    = var.bucket_location
  uniform_bucket_level_access = true
  force_destroy               = false

  # Optional and OFF by default (see variables.tf) — disposable renders are a
  # reasonable candidate for a TTL, but that is a deliberate choice for
  # whoever operates the bucket to make, not something this ticket enables
  # silently. What SCRUM-327 actually requires is that this rule can now
  # exist here at all WITHOUT risking the workspace bucket, because they are
  # no longer the same bucket.
  dynamic "lifecycle_rule" {
    for_each = var.artifacts_lifecycle_age_days != null ? [var.artifacts_lifecycle_age_days] : []
    content {
      condition {
        age = lifecycle_rule.value
      }
      action {
        type = "Delete"
      }
    }
  }
}

# The dedicated workspace bucket. Durable tenant state — never a lifecycle
# rule, ever, on this bucket. Enforced structurally below, not just by this
# comment: the `precondition` fails `terraform plan`/`apply` outright if a
# future edit ever adds a lifecycle_rule block here, rather than relying on
# a reviewer noticing.
resource "google_storage_bucket" "workspace" {
  project                     = var.project_id
  name                        = var.workspace_bucket_name
  location                    = var.bucket_location
  uniform_bucket_level_access = true
  force_destroy               = false

  # Durable tenant state warrants object versioning (recoverable from an
  # accidental overwrite/delete) in a way disposable renders do not.
  versioning {
    enabled = true
  }

  lifecycle {
    precondition {
      # This bucket resource must never grow a lifecycle_rule block. There is
      # no first-class way to reference "did this resource define block X" in
      # a precondition, so the guard instead re-asserts the actual invariant
      # decision 14 exists to protect: this bucket's name must never equal
      # the artifacts bucket's name. That is the condition under which a
      # lifecycle rule aimed at artifacts would reach workspace data, and it
      # is the one thing both a human edit and a bad merge could reintroduce.
      condition     = var.workspace_bucket_name != var.artifacts_bucket_name
      error_message = "GCS_WORKSPACE_BUCKET must be a dedicated bucket, never the artifacts bucket (SCRUM-327 / SCRUM-333 decision 14). Sharing retention policy between durable tenant state and 7-day disposable renders is the exact hazard this ticket closes."
    }
  }
}

resource "google_storage_bucket_iam_member" "agent_engine_media_object_admin" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.agent_engine.email}"
}

resource "google_storage_bucket_iam_member" "agent_engine_artifacts_object_admin" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.agent_engine.email}"
}

resource "google_storage_bucket_iam_member" "agent_engine_workspace_object_admin" {
  bucket = google_storage_bucket.workspace.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.agent_engine.email}"
}
