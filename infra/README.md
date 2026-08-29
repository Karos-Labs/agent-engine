# infra/

Docker images and CI pipeline for `agent-engine`, added at the Phase 1 exit
criteria in `docs/RFC-01-agent-engine-core.md` section 14 (once there's a
real pilot run to build a pipeline around).

## terraform/

SCRUM-327 (AU43): Terraform for the GCS buckets, Pub/Sub topic/subscription/
DLQ, and IAM that were previously hand-provisioned in `karoscmo-prep` and
`karoscmo`. See `terraform/README.md` for what's already live (needs
`import`) vs. net new (needs `apply`), and for the manual steps this repo
could not execute itself (no GCP credentials in this environment).
