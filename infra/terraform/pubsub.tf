# Run-jobs topic + pull subscription + DLQ. The topic and the main pull
# subscription already exist by hand in both environments (README.md's
# "Production: the pull consumer" section documents the live shape —
# `karos-agent-runs-<env>-pull`, consumed by a dedicated worker; there is NO
# push subscription in any environment despite what this same README section
# used to claim). The DLQ topic/subscription pair is the part the ticket
# calls out as not provisioned anywhere — this is net-new.
#
# CONFIRM run_jobs_subscription_name against the live PREP_QUEUE_SUBSCRIPTION
# / PROD_QUEUE_SUBSCRIPTION GitHub Actions variable before importing — this
# repo has no access to that variable's actual value, only to the fact that
# it exists (deploy-prep.yml / deploy-prod.yml's "Validate required repo
# variables" step).

data "google_project" "this" {
  project_id = var.project_id
}

resource "google_pubsub_topic" "run_jobs" {
  project = var.project_id
  name    = var.run_jobs_topic_name
}

resource "google_pubsub_topic" "run_jobs_dlq" {
  project = var.project_id
  name    = var.dlq_topic_name
}

resource "google_pubsub_subscription" "run_jobs_pull" {
  project              = var.project_id
  name                 = var.run_jobs_subscription_name
  topic                = google_pubsub_topic.run_jobs.id
  ack_deadline_seconds = var.run_jobs_ack_deadline_seconds

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.run_jobs_dlq.id
    max_delivery_attempts = var.dlq_max_delivery_attempts
  }

  # Matches README.md's stated production requirement for the worker
  # (`--no-cpu-throttling`, `min-instances=1`, a long ack deadline) — this is
  # the subscription-side half of "the render must not die mid-flight",
  # expire_after being effectively "never" so a quiet subscription is not
  # garbage-collected out from under a low-traffic environment like prep.
  expiration_policy {
    ttl = ""
  }
}

# A pull subscription on the DLQ topic — without this, a dead-lettered
# message accumulates in a topic nothing ever reads, which is functionally
# the same as having no DLQ at all except that it also hides the failure.
resource "google_pubsub_subscription" "run_jobs_dlq_pull" {
  project = var.project_id
  name    = var.dlq_subscription_name
  topic   = google_pubsub_topic.run_jobs_dlq.id

  expiration_policy {
    ttl = ""
  }
}

# Required for Pub/Sub's dead-letter delivery to function at all: the
# Pub/Sub service agent needs publisher on the DLQ topic and subscriber on
# the SOURCE subscription (not the DLQ subscription) — see
# https://cloud.google.com/pubsub/docs/handling-failures#assign_roles.
resource "google_pubsub_topic_iam_member" "pubsub_sa_publishes_to_dlq" {
  project = var.project_id
  topic   = google_pubsub_topic.run_jobs_dlq.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "pubsub_sa_forwards_dead_letters" {
  project      = var.project_id
  subscription = google_pubsub_subscription.run_jobs_pull.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# The runtime SA both publishes (POST /api/v1/runs/start, AU66/SCRUM-364) and
# subscribes (queue-consumer.js, the dedicated worker) to/from the run-jobs
# topic/subscription.
resource "google_pubsub_topic_iam_member" "agent_engine_publishes_run_jobs" {
  project = var.project_id
  topic   = google_pubsub_topic.run_jobs.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.agent_engine.email}"
}

resource "google_pubsub_subscription_iam_member" "agent_engine_subscribes_run_jobs" {
  project      = var.project_id
  subscription = google_pubsub_subscription.run_jobs_pull.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.agent_engine.email}"
}

# Whoever enqueues a run from outside this service (karosCMO/Portal) needs
# publisher on the topic too — README.md: "Whoever publishes ... needs
# roles/pubsub.publisher on agent-engine-run-jobs". Empty in an environment
# that has not established this caller identity yet (see variables.tf).
resource "google_pubsub_topic_iam_member" "external_publishers_run_jobs" {
  for_each = toset(var.run_jobs_publisher_service_accounts)
  project  = var.project_id
  topic    = google_pubsub_topic.run_jobs.name
  role     = "roles/pubsub.publisher"
  member   = "serviceAccount:${each.value}"
}

# roles/pubsub.subscriber on the DLQ pull subscription itself is deliberately
# NOT granted to the runtime SA here — draining the DLQ is an operational
# action for a human (or a separate, deliberately-built redrive tool), not
# something the running service should be able to do to its own dead
# letters. Grant it by hand (or extend this file with an explicit variable)
# if an automated redrive path gets built.
