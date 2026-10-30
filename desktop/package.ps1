$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$distRoot = Join-Path $projectRoot 'dist'
$appRoot = Join-Path $distRoot 'AnyControlAgent-Windows'
$zipPath = Join-Path $distRoot 'AnyControlAgent-Windows.zip'
Compress-Archive -Path (Join-Path $appRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal -Force
$bundle = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AnyControlAgent.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/out:$bundle" (Join-Path $PSScriptRoot 'Bootstrap.cs')
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap compilation failed' }
$output = [System.IO.File]::Open($bundle, [System.IO.FileMode]::Append)
try {
    $inputZip = [System.IO.File]::OpenRead($zipPath)
    try { $inputZip.CopyTo($output) } finally { $inputZip.Dispose() }
    $writer = [System.IO.BinaryWriter]::new($output)
    $writer.Write([long](Get-Item -LiteralPath $zipPath).Length)
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('ACA_BUNDLE_V1'))
    $writer.Flush()
} finally { $output.Dispose() }
Get-Item -LiteralPath $bundle, $zipPath | Select-Object FullName, Length
