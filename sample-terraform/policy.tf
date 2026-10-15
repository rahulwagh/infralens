resource "google_org_policy_policy" "no_sa_keys" {
  name   = "organizations/${var.org_id}/policies/iam.disableServiceAccountKeyCreation"
  parent = "organizations/${var.org_id}"
  spec {
    rules { enforce = "TRUE" }
  }
}

resource "google_org_policy_policy" "legacy_sa_keys" {
  name   = "projects/prj-legacy-batch-nonprod/policies/iam.disableServiceAccountKeyCreation"
  parent = "projects/prj-legacy-batch-nonprod"
  spec {
    rules { enforce = "FALSE" }
  }
}

resource "google_organization_policy" "locations" {
  org_id     = var.org_id
  constraint = "constraints/gcp.resourceLocations"
  list_policy {
    allow { values = ["in:eu-locations"] }
  }
}

resource "google_folder_organization_policy" "external_ips" {
  folder     = google_folder.workloads.name
  constraint = "compute.vmExternalIpAccess"
  list_policy {
    deny { all = true }
  }
}

resource "google_access_context_manager_access_level" "corp" {
  parent = "accessPolicies/987654321"
  name   = "accessPolicies/987654321/accessLevels/corp_network"
  title  = "Corporate network"
  basic {
    conditions {
      ip_subnetworks = ["198.51.100.0/24"]
    }
  }
}

resource "google_access_context_manager_service_perimeter" "prod" {
  parent         = "accessPolicies/987654321"
  name           = "accessPolicies/987654321/servicePerimeters/perimeter_prod"
  title          = "Production perimeter"
  perimeter_type = "PERIMETER_TYPE_REGULAR"
  status {
    resources           = [for pid, p in local.projects : "projects/${pid}" if p.labels.env == "prod"]
    restricted_services = ["storage.googleapis.com", "bigquery.googleapis.com"]
    access_levels       = [google_access_context_manager_access_level.corp.name]
    egress_policies {
      egress_from { identities = ["serviceAccount:sa-data-export@prj-data-platform-prod.iam.gserviceaccount.com"] }
      egress_to { resources = ["projects/prj-security-tooling"] }
    }
  }
}
