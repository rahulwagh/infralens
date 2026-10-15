# sample-terraform

Synthetic Terraform repository used to exercise `adapters/terraform.js`. It mixes
the patterns found in real estates: resources declared directly, `for_each` over
JSON loaded with `jsondecode(file(...))`, `fileset()`, dynamic blocks, a local
module, a remote (Bitbucket) module fed from JSON, standalone tfvars and a YAML
config. All ids are fake. Deliberate problems are included so findings fire.
