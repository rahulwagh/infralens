# Canonical model

Every adapter must produce an object of this shape. The dashboard only ever reads
this model — it never looks at your raw JSON directly. That is what makes the UI
generic: swap the adapter, keep the UI.

All arrays are optional (missing = empty). Every entity has:

- `id` — unique string across the whole model (used for linking and search)
- `source` — `{ file: "<relative path>", path: "<json pointer-ish>" }` so the UI can
  show where the entity came from

Entity ids are plain strings. References between entities use the *id* of the
target (e.g. a firewall rule's `network` is the network's id, which by convention is
`<project>/<network name>`).

```ts
type Model = {
  meta?: { org_id?: string, org_domain?: string, generated_from?: string }

  folders: {
    id: string            // "fld-shared"
    name: string
    parent: string | null // "organizations/123" | "folders/<id>" | null
  }[]

  projects: {
    id: string            // the project id
    name?: string
    folder?: string       // folder id
    labels?: Record<string,string>
    apis?: string[]
    shared_vpc_host?: string   // project id of the host, if this is a service project
    billing_account?: string
  }[]

  networks: {
    id: string            // "<project>/<name>"
    project: string
    name: string
    routing_mode?: "GLOBAL" | "REGIONAL"
    shared_vpc_host?: boolean
    service_projects?: string[]
  }[]

  subnets: {
    id: string            // "<project>/<network>/<name>"
    project: string
    network: string       // network id
    name: string
    region?: string
    cidr: string
    private_google_access?: boolean
    flow_logs?: boolean
    secondary_ranges?: { name: string, cidr: string }[]
  }[]

  peerings: {
    id: string
    project: string
    network: string       // network id
    name: string
    peer_network: string  // free-form reference
    export_custom_routes?: boolean
    import_custom_routes?: boolean
  }[]

  firewall_rules: {
    id: string            // "<project>/<name>"
    project: string
    network: string       // network id
    name: string
    direction: "INGRESS" | "EGRESS"
    action: "allow" | "deny"
    priority: number
    source_ranges?: string[]
    destination_ranges?: string[]
    source_tags?: string[]
    target_tags?: string[]
    source_service_accounts?: string[]
    target_service_accounts?: string[]
    rules: { protocol: string, ports?: string[] }[]   // protocol "all" allowed
    disabled?: boolean
    logging?: boolean
    description?: string
  }[]

  iam_bindings: {
    id: string
    resource_type: "organization" | "folder" | "project" | "service_account" | "bucket" | string
    resource: string      // id of the resource (project id, SA email, folder id ...)
    principal: string     // "group:x@y", "user:x@y", "serviceAccount:x@y", "allUsers", "principalSet://..."
    principal_type: "group" | "user" | "serviceAccount" | "allUsers" | "allAuthenticatedUsers" | "principal" | "principalSet" | "domain" | "unknown"
    role: string          // "roles/viewer"
    condition?: { title?: string, expression: string }
  }[]

  service_accounts: {
    id: string            // the email
    project: string
    email: string
    account_id: string
    display_name?: string
    description?: string
  }[]

  wif_pools: {
    id: string            // "<project>/<pool name>"
    project: string
    name: string
    display_name?: string
    disabled?: boolean
  }[]

  wif_providers: {
    id: string            // "<pool id>/<provider name>"
    pool: string          // pool id
    project: string
    name: string
    type?: "oidc" | "aws" | "saml" | string
    issuer_uri?: string
    attribute_mapping?: Record<string,string>
    attribute_condition?: string
  }[]

  // Which external identities may act as which SA (via workloadIdentityUser etc.).
  // Adapters may emit these explicitly, or the UI derives them from iam_bindings
  // whose principal starts with "principalSet://" / "principal://".
  wif_bindings: {
    id: string
    pool: string          // pool id
    service_account: string  // SA email
    principal_set: string
  }[]

  access_levels: {
    id: string
    name: string
    title?: string
    conditions?: any[]    // kept raw; rendered as JSON
  }[]

  vpc_sc_perimeters: {
    id: string
    name: string
    title?: string
    perimeter_type?: "regular" | "bridge"
    projects: string[]    // project ids (strip "projects/")
    restricted_services?: string[]
    access_levels?: string[]
    ingress_policies?: any[]   // kept raw
    egress_policies?: any[]    // kept raw
  }[]

  org_policies: {
    id: string
    constraint: string
    scope_type: "organization" | "folder" | "project"
    scope: string         // org id / folder id / project id
    policy_type?: "boolean" | "list"
    enforce?: boolean
    allow?: string[]
    deny?: string[]
    deny_all?: boolean
    allow_all?: boolean
    reason?: string
  }[]

  // Anything the adapter could not classify but wants visible.
  other: { id: string, kind: string, project?: string, data: any }[]
}
```

## Conventions

- Project ids are the GCP project id, never the number.
- Strip resource prefixes when building ids: `projects/foo` → `foo`, `folders/bar` → `bar`.
  Keep the prefix in `parent` fields of folders (that is how GCP expresses it).
- Member strings keep their GCP prefix (`group:`, `user:`, `serviceAccount:`).
- The adapter should **not** compute findings or risk. That lives in the UI's rules
  engine (`FINDINGS` in `index.html`) so it can be reused across adapters.
