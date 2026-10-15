variable "org_id" { type = string }
variable "org_domain" {
  type    = string
  default = "example-bank.se"
}
variable "billing_account" { type = string }
variable "env" {
  type    = string
  default = "prod"
}
variable "region" {
  type    = string
  default = "europe-west2"
}
variable "host_project_id" { type = string }
variable "enable_flow_logs" {
  type    = bool
  default = true
}
variable "ssh_source_ranges" {
  type    = list(string)
  default = ["10.200.0.0/16"]
}
