variable "project_id" { type = string }
variable "host_project" { type = string }
variable "region" { type = string }
variable "extra_rules" {
  type    = list(any)
  default = []
}
