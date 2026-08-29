terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }

  # No backend block on purpose: this repo does not choose where Terraform
  # state for a live GCP project lives — that is an operational decision
  # (GCS bucket + prefix, one per environment) that belongs to whoever runs
  # `terraform init` against the real project, not to source control. See
  # infra/terraform/README.md for the init command each environment needs.
}

provider "google" {
  project = var.project_id
  region  = var.region
}
