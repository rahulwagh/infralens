resource "google_folder" "shared" {
  display_name = "Shared Services"
  parent       = "organizations/${var.org_id}"
}
resource "google_folder" "workloads" {
  display_name = "Workloads"
  parent       = "organizations/${var.org_id}"
}
resource "google_folder" "workloads_prod" {
  display_name = "Production"
  parent       = google_folder.workloads.name
}

resource "google_project" "p" {
  for_each        = local.projects
  project_id      = each.key
  name            = each.value.name
  folder_id       = each.value.folder == "shared" ? google_folder.shared.name : google_folder.workloads_prod.name
  billing_account = var.billing_account
  labels          = merge(local.common_labels, each.value.labels)
}

resource "google_project_service" "apis" {
  for_each = { for x in flatten([for pid, p in local.projects : [for s in p.services : { k = "${pid}/${s}", pid = pid, s = s }]]) : x.k => x }
  project  = each.value.pid
  service  = each.value.s
}
