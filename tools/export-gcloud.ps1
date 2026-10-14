<#
.SYNOPSIS
  Exports the live GCP estate to a snapshot folder that InfraLens can open.

.DESCRIPTION
  Runs read-only gcloud commands (list / describe / get-iam-policy) and writes each
  result as JSON under the output folder. Nothing is modified in GCP. Every command
  is wrapped so one failure (missing permission, API not enabled) is logged to
  _errors.log and the export continues.

  Needs: gcloud on PATH, an authenticated account (gcloud auth login or ADC),
  and read access. Org-wide reads work best with roles/viewer +
  roles/iam.securityReviewer + roles/accesscontextmanager.policyReader +
  roles/orgpolicy.policyViewer on the organisation. Without org access, use
  -Projects to export only the projects you can see.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\export-gcloud.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\export-gcloud.ps1 -Organization 123456789012 -Out snapshot
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\export-gcloud.ps1 -Projects prj-a,prj-b -SkipOrg
#>
param(
  [string]$Organization = "",          # numeric org id; auto-detected if empty
  [string[]]$Projects = @(),           # restrict to these project ids (default: all visible)
  [string]$Out = "snapshot",           # output folder
  [switch]$SkipOrg,                    # skip org-level reads (folders, VPC-SC, org policies, org IAM)
  [switch]$SkipSaPolicies,             # skip per-service-account IAM policies (slowest part)
  [string]$ProjectFilter = ""          # gcloud --filter for projects list, e.g. "labels.env=prod"
)
$ErrorActionPreference = "Continue"
$Out = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force -Path $Out)).Path
$errLog = Join-Path $Out "_errors.log"
"" | Set-Content $errLog

function Run-Gcloud {
  # Runs a gcloud command, saves JSON to $file, returns parsed object (or $null).
  param([string]$file, [string[]]$args)
  $dir = Split-Path $file -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Write-Host ("  gcloud " + ($args -join " ")) -ForegroundColor DarkGray
  $output = & gcloud @args --format=json --quiet 2>&1
  if ($LASTEXITCODE -ne 0) {
    $msg = ($output | Out-String).Trim()
    Add-Content $errLog ("[" + (Get-Date -Format "HH:mm:ss") + "] gcloud " + ($args -join " ") + "`n    " + $msg)
    Write-Host ("    failed: " + ($msg -split "`n")[0]) -ForegroundColor Yellow
    return $null
  }
  $json = ($output | Where-Object { $_ -is [string] }) -join "`n"
  if (-not $json.Trim()) { $json = "[]" }
  Set-Content -Path $file -Value $json -Encoding UTF8
  try { return ($json | ConvertFrom-Json) } catch { return $null }
}
function Safe-Name([string]$s) { return ($s -replace '[^A-Za-z0-9._@-]', '_') }

Write-Host "InfraLens gcloud export -> $Out"
$account = (& gcloud config get-value account 2>$null)
Write-Host "account: $account"

# ---------- organisation ----------
$orgDomain = ""
if (-not $SkipOrg) {
  $orgs = Run-Gcloud (Join-Path $Out "org\organizations.json") @("organizations", "list")
  if (-not $Organization -and $orgs) { $Organization = ($orgs[0].name -replace 'organizations/', ''); $orgDomain = $orgs[0].displayName }
  elseif ($orgs) { $o = $orgs | Where-Object { $_.name -eq "organizations/$Organization" }; if ($o) { $orgDomain = $o.displayName } }
}
if ($Organization) { Write-Host "organization: $Organization ($orgDomain)" } else { Write-Host "organization: (none / not visible)" -ForegroundColor Yellow }

$meta = [ordered]@{ exported_at = (Get-Date).ToString("o"); account = $account; organization_id = $Organization; organization_domain = $orgDomain; exporter = "export-gcloud.ps1" }

if (-not $SkipOrg -and $Organization) {
  Write-Host "org-level resources"
  # folders, recursively
  $allFolders = @()
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue("organizations/$Organization")
  while ($queue.Count -gt 0) {
    $parent = $queue.Dequeue()
    $flag = if ($parent -like "organizations/*") { "--organization=" + ($parent -replace 'organizations/', '') } else { "--folder=" + ($parent -replace 'folders/', '') }
    $tmp = Join-Path $Out ("org\_folders_" + (Safe-Name $parent) + ".json")
    $kids = Run-Gcloud $tmp @("resource-manager", "folders", "list", $flag)
    Remove-Item $tmp -ErrorAction SilentlyContinue
    if ($kids) { foreach ($k in @($kids)) { $allFolders += $k; $queue.Enqueue($k.name) } }
  }
  ($allFolders | ConvertTo-Json -Depth 10) | Set-Content (Join-Path $Out "org\folders.json") -Encoding UTF8
  Write-Host ("  folders: " + $allFolders.Count)

  Run-Gcloud (Join-Path $Out "org\iam_policy.json") @("organizations", "get-iam-policy", $Organization) | Out-Null
  Run-Gcloud (Join-Path $Out "org\org_policies.json") @("org-policies", "list", "--organization=$Organization") | Out-Null
  foreach ($f in $allFolders) {
    $fid = $f.name -replace 'folders/', ''
    Run-Gcloud (Join-Path $Out "folders\$fid\iam_policy.json") @("resource-manager", "folders", "get-iam-policy", $fid) | Out-Null
    Run-Gcloud (Join-Path $Out "folders\$fid\org_policies.json") @("org-policies", "list", "--folder=$fid") | Out-Null
  }

  # VPC Service Controls
  $policies = Run-Gcloud (Join-Path $Out "org\access_policies.json") @("access-context-manager", "policies", "list", "--organization=$Organization")
  if ($policies) {
    foreach ($p in @($policies)) {
      $pid = $p.name -replace 'accessPolicies/', ''
      Run-Gcloud (Join-Path $Out "org\access_levels_$pid.json") @("access-context-manager", "levels", "list", "--policy=$pid") | Out-Null
      Run-Gcloud (Join-Path $Out "org\perimeters_$pid.json") @("access-context-manager", "perimeters", "list", "--policy=$pid") | Out-Null
    }
  }
}

# ---------- projects ----------
Write-Host "projects"
$listArgs = @("projects", "list")
if ($ProjectFilter) { $listArgs += "--filter=$ProjectFilter" }
$allProjects = Run-Gcloud (Join-Path $Out "org\projects.json") $listArgs
if (-not $allProjects) { $allProjects = @() }
if ($Projects.Count -gt 0) { $allProjects = @($allProjects | Where-Object { $Projects -contains $_.projectId }) }
$allProjects = @($allProjects | Where-Object { $_.lifecycleState -eq "ACTIVE" -or -not $_.lifecycleState })
Write-Host ("  " + $allProjects.Count + " project(s)")

$i = 0
foreach ($p in $allProjects) {
  $i++; $id = $p.projectId
  Write-Host ("[" + $i + "/" + $allProjects.Count + "] " + $id) -ForegroundColor Cyan
  $d = Join-Path $Out "projects\$id"
  Run-Gcloud "$d\project.json" @("projects", "describe", $id) | Out-Null
  Run-Gcloud "$d\iam_policy.json" @("projects", "get-iam-policy", $id) | Out-Null
  Run-Gcloud "$d\org_policies.json" @("org-policies", "list", "--project=$id") | Out-Null
  Run-Gcloud "$d\services.json" @("services", "list", "--enabled", "--project=$id") | Out-Null
  Run-Gcloud "$d\networks.json" @("compute", "networks", "list", "--project=$id") | Out-Null
  Run-Gcloud "$d\subnets.json" @("compute", "networks", "subnets", "list", "--project=$id") | Out-Null
  Run-Gcloud "$d\firewall_rules.json" @("compute", "firewall-rules", "list", "--project=$id") | Out-Null
  Run-Gcloud "$d\shared_vpc_host.json" @("compute", "shared-vpc", "get-host-project", $id) | Out-Null
  Run-Gcloud "$d\shared_vpc_service_projects.json" @("compute", "shared-vpc", "associated-projects", "list", $id) | Out-Null

  $sas = Run-Gcloud "$d\service_accounts.json" @("iam", "service-accounts", "list", "--project=$id")
  if ($sas -and -not $SkipSaPolicies) {
    foreach ($sa in @($sas)) {
      Run-Gcloud ("$d\sa_iam\" + (Safe-Name $sa.email) + ".json") @("iam", "service-accounts", "get-iam-policy", $sa.email, "--project=$id") | Out-Null
    }
  }

  $pools = Run-Gcloud "$d\wif_pools.json" @("iam", "workload-identity-pools", "list", "--location=global", "--project=$id")
  if ($pools) {
    foreach ($pool in @($pools)) {
      $poolName = ($pool.name -split '/')[-1]
      Run-Gcloud ("$d\wif_providers\" + (Safe-Name $poolName) + ".json") @("iam", "workload-identity-pools", "providers", "list", "--workload-identity-pool=$poolName", "--location=global", "--project=$id") | Out-Null
    }
  }
}

($meta | ConvertTo-Json) | Set-Content (Join-Path $Out "_meta.json") -Encoding UTF8
$errCount = (Get-Content $errLog | Where-Object { $_ -like "[[]*" }).Count
Write-Host ""
Write-Host ("done. " + $allProjects.Count + " projects exported to " + $Out + ". " + $errCount + " command(s) failed (see _errors.log).") -ForegroundColor Green
Write-Host "Open index.html and pick the '$Out' folder."
