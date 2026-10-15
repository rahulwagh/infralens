terraform {
  required_version = ">= 1.5"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
  backend "gcs" {
    bucket = "tfstate-example"
    prefix = "landing-zone"
  }
}

provider "google" {
  project = var.host_project_id
  region  = var.region
}
