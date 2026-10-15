# No-code module from another repo: the whole config is JSON passed as inputs.
module "landing_zone" {
  source  = "git::https://bitbucket.example-bank.se/scm/plat/tf-gcp-landing-zone.git?ref=v3.2.0"
  org_id  = var.org_id
  config  = jsondecode(file("${path.module}/config/landing-zone.json"))
  folders = {
    "Security" = { parent = "organizations/${var.org_id}" }
  }
}

module "service_project" {
  for_each = { for pid, p in local.projects : pid => p if p.folder != "shared" }
  source   = "./modules/service-project"
  project_id   = each.key
  host_project = var.host_project_id
  region       = var.region
  extra_rules  = lookup(each.value, "extra_rules", [])
}
