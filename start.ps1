param([string]$Workspace = $PWD.Path, [int]$Port = 8787)
$ErrorActionPreference = 'Stop'
$env:BRIDGE_CWD = (Resolve-Path -LiteralPath $Workspace).Path
$env:PORT = "$Port"
Push-Location $PSScriptRoot
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 or 24 LTS first.' }
  if (-not (Test-Path node_modules)) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. See README troubleshooting.' }
  }
  & node server.mjs
} finally { Pop-Location }
