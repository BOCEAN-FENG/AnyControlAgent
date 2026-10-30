$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$outputRoot = Join-Path $projectRoot 'dist\AnyControlAgent-Windows'
New-Item -ItemType Directory -Force -Path $outputRoot, (Join-Path $outputRoot 'runtime'), (Join-Path $outputRoot 'desktop') | Out-Null
foreach ($name in @('server.mjs', 'package.json', 'package-lock.json', 'LICENSE')) { Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $outputRoot -Force }
foreach ($name in @('public', 'node_modules')) { Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $outputRoot -Recurse -Force }
foreach ($name in @('host.mjs', 'cloudflared.yml')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $outputRoot 'desktop') -Force }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '使用说明.txt') -Destination $outputRoot -Force
Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $outputRoot 'runtime\node.exe') -Force
Copy-Item -LiteralPath (Get-Command cloudflared.exe).Source -Destination (Join-Path $outputRoot 'runtime\cloudflared.exe') -Force
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$outputRoot\AnyControlAgent.exe" (Join-Path $PSScriptRoot 'Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'EXE compilation failed' }
Write-Output "Built: $outputRoot\AnyControlAgent.exe"
