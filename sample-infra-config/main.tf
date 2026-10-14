# Illustrative "no-code module" wiring. InfraLens does not execute Terraform;
# it reads the JSON files this module consumes. Replace with your real wiring.

locals {
  project_files = fileset("${path.module}/projects", "*.json")
  projects      = { for f in local.project_files : trimsuffix(f, ".json") => jsondecode(file("${path.module}/projects/${f}")) }
  org           = jsondecode(file("${path.module}/org/folders.json"))
  org_policies  = jsondecode(file("${path.module}/org/org_policies.json"))
  vpc_sc        = jsondecode(file("${path.module}/org/vpc_sc.json"))
}

module "landing_zone" {
  source       = "git::ssh://git@bitbucket.example-bank.se/cloud/tf-module-landing-zone.git?ref=v3.4.0"
  organization = local.org.organization
  folders      = local.org.folders
  org_policies = local.org_policies.org_policies
  vpc_sc       = local.vpc_sc
}

module "project" {
  for_each = local.projects
  source   = "git::ssh://git@bitbucket.example-bank.se/cloud/tf-module-project.git?ref=v5.1.2"
  config   = each.value
}
