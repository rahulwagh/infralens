locals {
  projects = jsondecode(file("${path.module}/config/projects.json"))
  fw_files = fileset(path.module, "config/firewall/*.json")
  fw_rules = merge([for f in local.fw_files : { for r in jsondecode(file("${path.module}/${f}")).rules : "${jsondecode(file("${path.module}/${f}")).project}/${r.name}" => merge(r, { project = jsondecode(file("${path.module}/${f}")).project }) }]...)
  iam_cfg  = yamldecode(file("${path.module}/config/iam.yaml"))
  project_bindings = flatten([
    for pid, p in local.projects : [
      for role, members in lookup(p, "iam", {}) : [
        for m in members : { project = pid, role = role, member = m }
      ]
    ]
  ])
  subnets = {
    "sn-prod-app"  = { cidr = cidrsubnet("10.10.0.0/16", 8, 1), pga = true }
    "sn-prod-data" = { cidr = cidrsubnet("10.10.0.0/16", 8, 2), pga = true }
    "sn-legacy"    = { cidr = "10.99.0.0/24", pga = false }
  }
  common_labels = { managed_by = "terraform", env = var.env }
}
