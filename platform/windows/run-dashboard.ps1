param(
  [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw 'Node.js 24+ is required. Install Node.js, then run this script again.'
}

$env:PAB_DASHBOARD_PORT = [string]$Port
Push-Location $root
try {
  & $node.Source 'apps/dashboard/preview.mjs'
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
