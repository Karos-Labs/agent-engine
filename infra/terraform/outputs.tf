output "runtime_service_account_email" {
  value = google_service_account.agent_engine.email
}

output "media_bucket" {
  value = google_storage_bucket.media.name
}

output "artifacts_bucket" {
  value = google_storage_bucket.artifacts.name
}

output "workspace_bucket" {
  value = google_storage_bucket.workspace.name
}

output "run_jobs_topic" {
  value = google_pubsub_topic.run_jobs.name
}

output "run_jobs_subscription" {
  value = google_pubsub_subscription.run_jobs_pull.name
}

output "run_jobs_dlq_topic" {
  value = google_pubsub_topic.run_jobs_dlq.name
}

output "run_jobs_dlq_subscription" {
  value = google_pubsub_subscription.run_jobs_dlq_pull.name
}
