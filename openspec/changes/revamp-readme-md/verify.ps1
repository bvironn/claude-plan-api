#requires -Version 5.1
<#
.SYNOPSIS
  Verifier for SDD change "Revamp README.md".

.DESCRIPTION
  Runs the 13 checks locked in openspec/changes/revamp-readme-md/design.md
  against the working tree. Self-contained: uses only built-in PowerShell
  cmdlets plus `git`. Idempotent: read-only, no mutations.

  Run from the repository root:
    pwsh ./openspec/changes/revamp-readme-md/verify.ps1
  Or:
    powershell -NoProfile -File ./openspec/changes/revamp-readme-md/verify.ps1

  Exit code:
    0  all checks passed
    1  one or more checks failed
#>

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Anchor to repo root regardless of invocation cwd
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Resolve-Path (Join-Path $scriptDir "..\..\..")
Set-Location $repoRoot

$results = New-Object System.Collections.Generic.List[object]
function Add-Result {
  param([int]$Num, [string]$Name, [bool]$Pass, [string]$Detail = "")
  $results.Add([pscustomobject]@{
    Num    = $Num
    Name   = $Name
    Pass   = $Pass
    Detail = $Detail
  })
}

$readmePath = "README.md"
$readmeLines   = if (Test-Path $readmePath) { Get-Content $readmePath } else { @() }
$readmeContent = if (Test-Path $readmePath) { Get-Content $readmePath -Raw } else { "" }

# ----------------------------------------------------------------------
# 1. Line count: 170 <= length <= 220
# ----------------------------------------------------------------------
$count1 = $readmeLines.Length
$pass1  = ($count1 -ge 170) -and ($count1 -le 220)
Add-Result 1 "README line count in [170, 220]" $pass1 "lines=$count1"

# ----------------------------------------------------------------------
# 2. Exactly 12 ## headings in locked order
# ----------------------------------------------------------------------
$expectedH2 = @(
  "## Pitch",
  "## Disclaimer",
  "## Quickstart",
  "## API",
  "## Dashboard",
  "## Architecture",
  "## Development & build",
  "## Configuration",
  "## Adaptive thinking",  # prefix match - heading uses em-dash in the actual README
  "## Project status & scope",
  "## Further reading",
  "## License"
)
$actualH2 = @($readmeLines | Where-Object { $_ -match "^## " })
$pass2 = $true
$detail2 = "found=$($actualH2.Count) expected=12"
if ($actualH2.Count -ne 12) {
  $pass2 = $false
} else {
  for ($i = 0; $i -lt 12; $i++) {
    if (-not $actualH2[$i].StartsWith($expectedH2[$i])) {
      $pass2 = $false
      $detail2 += " mismatch@$($i+1): '$($actualH2[$i])' !~ '$($expectedH2[$i])'"
      break
    }
  }
}
Add-Result 2 "12 ## headings present in locked order" $pass2 $detail2

# ----------------------------------------------------------------------
# 3. Required anchors present (heading-text equivalents)
# ----------------------------------------------------------------------
$requiredAnchors = @{
  "api"           = "^## API\s*$"
  "dashboard"     = "^## Dashboard\s*$"
  "architecture"  = "^## Architecture\s*$"
  "configuration" = "^## Configuration\s*$"
  "disclaimer"    = "^## Disclaimer\s*$"
}
$missing = @()
foreach ($a in $requiredAnchors.Keys) {
  $rx = $requiredAnchors[$a]
  if (-not ($readmeLines | Where-Object { $_ -match $rx })) {
    $missing += $a
  }
}
$pass3 = $missing.Count -eq 0
Add-Result 3 "Required anchor headings present" $pass3 "missing=[$($missing -join ',')]"

# ----------------------------------------------------------------------
# 4. Route accuracy: every README endpoint resolves in src/http/server.ts
# ----------------------------------------------------------------------
$readmeEndpoints = New-Object System.Collections.Generic.List[string]
foreach ($line in $readmeLines) {
  if ($line -match '\|\s*`(GET|POST|PUT|DELETE|PATCH)\s+(/[\w/:.\-]+)`') {
    [void]$readmeEndpoints.Add("$($matches[1]) $($matches[2])")
  }
}
$serverPath = "src/http/server.ts"
$serverContent = if (Test-Path $serverPath) { Get-Content $serverPath -Raw } else { "" }
$unresolved = @()
foreach ($ep in $readmeEndpoints) {
  $parts  = $ep -split " ", 2
  $method = $parts[0]
  $path   = $parts[1]
  # Strip ":param" -> the server uses startsWith for parameterised routes.
  $base   = ($path -split ':')[0].TrimEnd('/')
  $hasParam = $path.Contains(':')
  $exactRx = "method === ""$method"" && pathname === ""$([regex]::Escape($path))"""
  $startsRx = "method === ""$method"" && pathname\.startsWith\(""$([regex]::Escape($base))"
  if ($serverContent -match $exactRx) { continue }
  if ($hasParam -and ($serverContent -match $startsRx)) { continue }
  $unresolved += $ep
}
$pass4 = $unresolved.Count -eq 0
Add-Result 4 "Every README endpoint resolves in src/http/server.ts" $pass4 "unresolved=[$($unresolved -join '; ')]"

# ----------------------------------------------------------------------
# 5. Env var accuracy: bidirectional README config table <-> Bun.env.X
# ----------------------------------------------------------------------
$readmeVars = New-Object System.Collections.Generic.HashSet[string]
$inConfig = $false
foreach ($line in $readmeLines) {
  if ($line -match '^## Configuration\s*$') { $inConfig = $true; continue }
  if ($inConfig -and $line -match '^## ') { break }
  if ($inConfig -and $line -match '\|\s*`([A-Z_][A-Z0-9_]+)`\s*\|') {
    [void]$readmeVars.Add($matches[1])
  }
}

$configPath = "src/config.ts"
$configRaw  = if (Test-Path $configPath) { Get-Content $configPath -Raw } else { "" }
$configVars = New-Object System.Collections.Generic.HashSet[string]
foreach ($m in [regex]::Matches($configRaw, 'Bun\.env\.([A-Z_][A-Z0-9_]+)')) {
  [void]$configVars.Add($m.Groups[1].Value)
}

$inReadmeNotConfig = @($readmeVars | Where-Object { -not $configVars.Contains($_) })
$inConfigNotReadme = @($configVars | Where-Object { -not $readmeVars.Contains($_) })
$pass5 = ($inReadmeNotConfig.Count -eq 0) -and ($inConfigNotReadme.Count -eq 0)
Add-Result 5 "Env vars match bidirectionally README <-> src/config.ts" $pass5 "readme_only=[$($inReadmeNotConfig -join ',')] config_only=[$($inConfigNotReadme -join ',')]"

# ----------------------------------------------------------------------
# 6. No live numeric badges
# ----------------------------------------------------------------------
$pass6 = -not ($readmeContent -match 'shields\.io/badge/(tests|coverage|builds)-\d')
Add-Result 6 "No live numeric badges (tests/coverage/builds-NN)" $pass6 ""

# ----------------------------------------------------------------------
# 7. Quickstart section length <= 40 lines
# ----------------------------------------------------------------------
$qstartIdx = -1
$qendIdx   = $readmeLines.Length
for ($i = 0; $i -lt $readmeLines.Length; $i++) {
  if ($readmeLines[$i] -match '^## Quickstart\s*$') { $qstartIdx = $i; continue }
  if ($qstartIdx -ge 0 -and $readmeLines[$i] -match '^## ') { $qendIdx = $i; break }
}
$qlen = if ($qstartIdx -ge 0) { $qendIdx - $qstartIdx } else { -1 }
$pass7 = ($qstartIdx -ge 0) -and ($qlen -le 40)
Add-Result 7 "Quickstart section length <= 40 lines" $pass7 "length=$qlen"

# ----------------------------------------------------------------------
# 8. Adaptive thinking section body <= 6 lines AND links to sub-doc
# ----------------------------------------------------------------------
$aStartIdx = -1
$aEndIdx   = $readmeLines.Length
for ($i = 0; $i -lt $readmeLines.Length; $i++) {
  if ($readmeLines[$i] -match '^## Adaptive thinking') { $aStartIdx = $i; continue }
  if ($aStartIdx -ge 0 -and $readmeLines[$i] -match '^## ') { $aEndIdx = $i; break }
}
$bodyLen = if ($aStartIdx -ge 0) { $aEndIdx - $aStartIdx - 1 } else { -1 }
$bodyText = if ($aStartIdx -ge 0) {
  ($readmeLines[($aStartIdx + 1)..($aEndIdx - 1)]) -join "`n"
} else { "" }
$pass8 = ($aStartIdx -ge 0) -and ($bodyLen -le 6) -and ($bodyText.Contains("docs/adaptive-thinking.md"))
Add-Result 8 "Adaptive thinking body <= 6 lines and links to sub-doc" $pass8 "body=$bodyLen linked=$($bodyText.Contains('docs/adaptive-thinking.md'))"

# ----------------------------------------------------------------------
# 9. Exactly one ## Disclaimer heading
# ----------------------------------------------------------------------
$disclaimerCount = @($readmeLines | Where-Object { $_ -match '^## Disclaimer\s*$' }).Count
$pass9 = $disclaimerCount -eq 1
Add-Result 9 "Exactly one '## Disclaimer' heading" $pass9 "count=$disclaimerCount"

# ----------------------------------------------------------------------
# 10. docs/adaptive-thinking.md exists and >= 25 lines
# ----------------------------------------------------------------------
$adaptivePath = "docs/adaptive-thinking.md"
$adaptiveExists = Test-Path $adaptivePath
$adaptiveLines  = if ($adaptiveExists) { (Get-Content $adaptivePath).Length } else { 0 }
$pass10 = $adaptiveExists -and ($adaptiveLines -ge 25)
Add-Result 10 "docs/adaptive-thinking.md exists and >= 25 lines" $pass10 "exists=$adaptiveExists lines=$adaptiveLines"

# ----------------------------------------------------------------------
# 11. Orphan folder openspec/changes/revamp-readme/ does not exist
# ----------------------------------------------------------------------
$orphanPath = "openspec/changes/revamp-readme"
$pass11 = -not (Test-Path $orphanPath)
Add-Result 11 "Orphan folder openspec/changes/revamp-readme/ does not exist" $pass11 "exists=$(-not $pass11)"

# ----------------------------------------------------------------------
# 12. Out-of-scope guard: git diff HEAD only touches allowed paths
# ----------------------------------------------------------------------
$diffRaw = (& git diff --name-only HEAD) 2>&1
$changedFiles = @()
if ($LASTEXITCODE -eq 0) {
  $changedFiles = $diffRaw | Where-Object { $_ -and $_.Trim() -ne "" }
}
$allowedPatterns = @(
  '^README\.md$',
  '^docs/adaptive-thinking\.md$',
  '^openspec/changes/revamp-readme-md/.*$',
  '^openspec/changes/revamp-readme(/|$)'  # the deleted orphan path
)
$disallowed = @()
foreach ($f in $changedFiles) {
  $ok = $false
  foreach ($p in $allowedPatterns) {
    if ($f -match $p) { $ok = $true; break }
  }
  if (-not $ok) { $disallowed += $f }
}
$pass12 = $disallowed.Count -eq 0
Add-Result 12 "Out-of-scope guard (git diff)" $pass12 "disallowed=[$($disallowed -join ', ')]"

# ----------------------------------------------------------------------
# 13. Required link targets present in README
# ----------------------------------------------------------------------
$requiredLinks = @(
  "OBSERVABILITY.md",
  "CLAUDE.md",
  "openspec/",
  "docs/audit-2026-04-17.md",
  "docs/adaptive-thinking.md"
)
$missingLinks = @()
foreach ($l in $requiredLinks) {
  if (-not $readmeContent.Contains($l)) { $missingLinks += $l }
}
$pass13 = $missingLinks.Count -eq 0
Add-Result 13 "Required link targets present in README" $pass13 "missing=[$($missingLinks -join ',')]"

# ----------------------------------------------------------------------
# Report
# ----------------------------------------------------------------------
$passCount = @($results | Where-Object Pass).Count
$failCount = @($results | Where-Object { -not $_.Pass }).Count

Write-Host ""
Write-Host "===== Revamp README.md - verify.ps1 ====="
foreach ($r in $results) {
  $tag = if ($r.Pass) { "PASS" } else { "FAIL" }
  $detail = if ($r.Detail) { " - $($r.Detail)" } else { "" }
  Write-Host ("  [{0}] {1,2}. {2}{3}" -f $tag, $r.Num, $r.Name, $detail)
}
Write-Host ""
Write-Host "Summary: $passCount passed, $failCount failed (of $($results.Count))"
Write-Host ""

if ($failCount -gt 0) { exit 1 } else { exit 0 }
