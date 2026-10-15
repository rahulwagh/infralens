resource "google_project_iam_member" "bindings" {
  for_each = { for b in local.project_bindings : "${b.project}/${b.role}/${b.member}" => b }
  project  = each.value.project
  role     = each.value.role
  member   = each.value.member
}

resource "google_organization_iam_member" "org_viewers" {
  for_each = toset(local.iam_cfg.organization["roles/resourcemanager.organizationViewer"])
  org_id   = var.org_id
  role     = "roles/resourcemanager.organizationViewer"
  member   = each.value
}

resource "google_folder_iam_member" "folder_admins" {
  folder = google_folder.workloads.name
  role   = "roles/resourcemanager.folderAdmin"
  member = "group:gcp-platform-admins@example-bank.se"
}

resource "google_service_account" "sa" {
  for_each     = { for x in flatten([for pid, p in local.projects : [for sa in lookup(p, "service_accounts", []) : merge(sa, { project = pid })]]) : "${x.project}/${x.account_id}" => x }
  project      = each.value.project
  account_id   = each.value.account_id
  display_name = each.value.display_name
  description  = lookup(each.value, "description", null)
}

# roles granted to each SA on its own project
resource "google_project_iam_member" "sa_roles" {
  for_each = { for x in flatten([for k, sa in google_service_account.sa : [for r in lookup(local.projects[sa.project].service_accounts[index(local.projects[sa.project].service_accounts[*].account_id, sa.account_id)], "roles", []) : { k = "${k}/${r}", project = sa.project, role = r, member = sa.member }]]) : x.k => x }
  project  = each.value.project
  role     = each.value.role
  member   = each.value.member
}

# who can impersonate the deployer SA
resource "google_service_account_iam_member" "deployer_users" {
  for_each           = toset(["group:gcp-platform-admins@example-bank.se", "user:anna.lind@example-bank.se"])
  service_account_id = google_service_account.sa["prj-payments-prod/sa-payments-deployer"].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = each.value
}

resource "google_project_iam_member" "contractor" {
  project = "prj-legacy-batch-nonprod"
  role    = "roles/editor"
  member  = "user:ext.contractor@gmail.com"
  condition {
    title      = "expires_2026"
    expression = "request.time < timestamp(\"2026-12-31T00:00:00Z\")"
  }
}
