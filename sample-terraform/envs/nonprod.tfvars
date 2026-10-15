# Passed with -var-file for the non-prod pipeline; not auto-loaded.
host_project_id = "prj-shared-net-nonprod"
env             = "nonprod"

firewall_rules = [
  { name = "allow-dev-ssh", project = "prj-shared-net-nonprod", source_ranges = ["0.0.0.0/0"], allow = [{ protocol = "tcp", ports = ["22"] }] },
]
