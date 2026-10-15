locals {
  deployer = "sa-${var.project_id}-cicd"
}

resource "google_service_account" "cicd" {
  project      = var.project_id
  account_id   = local.deployer
  display_name = "CI/CD deployer for ${var.project_id}"
}

resource "google_project_iam_member" "cicd_roles" {
  for_each = toset(["roles/compute.admin", "roles/iam.serviceAccountUser"])
  project  = var.project_id
  role     = each.key
  member   = google_service_account.cicd.member
}

resource "google_compute_firewall" "extra" {
  count     = length(var.extra_rules)
  name      = var.extra_rules[count.index].name
  project   = var.host_project
  network   = "vpc-host-prod"
  direction = "INGRESS"
  source_ranges = var.extra_rules[count.index].sources
  target_service_accounts = [google_service_account.cicd.email]
  allow {
    protocol = "tcp"
    ports    = var.extra_rules[count.index].ports
  }
}
