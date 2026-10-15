resource "google_compute_network" "host" {
  name                    = "vpc-host-${var.env}"
  project                 = var.host_project_id
  routing_mode            = "GLOBAL"
  auto_create_subnetworks = false
}

resource "google_compute_shared_vpc_host_project" "host" {
  project = var.host_project_id
}

resource "google_compute_shared_vpc_service_project" "svc" {
  for_each        = { for pid, p in local.projects : pid => p if p.folder != "shared" }
  host_project    = var.host_project_id
  service_project = each.key
}

resource "google_compute_subnetwork" "sn" {
  for_each                 = local.subnets
  name                     = each.key
  project                  = var.host_project_id
  region                   = var.region
  network                  = google_compute_network.host.self_link
  ip_cidr_range            = each.value.cidr
  private_ip_google_access = each.value.pga

  dynamic "log_config" {
    for_each = var.enable_flow_logs && each.value.pga ? [1] : []
    content {
      aggregation_interval = "INTERVAL_5_SEC"
      flow_sampling        = 0.5
    }
  }
}

resource "google_compute_network_peering" "to_legacy" {
  name                 = "peer-legacy"
  network              = google_compute_network.host.self_link
  peer_network         = "projects/prj-legacy-batch-nonprod/global/networks/vpc-legacy"
  export_custom_routes = true
}

# Firewall rules come from config/firewall/*.json, one file per project.
resource "google_compute_firewall" "rules" {
  for_each  = local.fw_rules
  name      = each.value.name
  project   = var.host_project_id # shared VPC: rules live in the host project
  description = "owner: ${each.value.project}"
  network   = google_compute_network.host.name
  direction = upper(lookup(each.value, "direction", "ingress"))
  priority  = lookup(each.value, "priority", 1000)
  disabled  = lookup(each.value, "disabled", false)

  source_ranges      = lookup(each.value, "source_ranges", null)
  destination_ranges = lookup(each.value, "destination_ranges", null)
  target_tags        = lookup(each.value, "target_tags", null)
  target_service_accounts = lookup(each.value, "target_service_accounts", null)

  dynamic "allow" {
    for_each = lookup(each.value, "allow", [])
    content {
      protocol = allow.value.protocol
      ports    = lookup(allow.value, "ports", null)
    }
  }
  dynamic "deny" {
    for_each = lookup(each.value, "deny", [])
    content {
      protocol = deny.value.protocol
      ports    = lookup(deny.value, "ports", null)
    }
  }
  dynamic "log_config" {
    for_each = lookup(each.value, "logging", true) ? [1] : []
    content { metadata = "INCLUDE_ALL_METADATA" }
  }
}

# A rule written directly, the old way.
resource "google_compute_firewall" "allow_iap_ssh" {
  name          = "allow-iap-ssh"
  project       = var.host_project_id
  network       = google_compute_network.host.id
  direction     = "INGRESS"
  priority      = 900
  source_ranges = concat(["35.235.240.0/20"], var.ssh_source_ranges)
  target_tags   = ["ssh"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  log_config { metadata = "INCLUDE_ALL_METADATA" }
}
