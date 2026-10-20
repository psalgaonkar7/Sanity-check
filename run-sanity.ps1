# Run the full Rail Europe sanity check - standalone, no Claude Code needed.
# Double-click this file (or right-click -> Run with PowerShell), or run it from a terminal:
#   .\run-sanity.ps1
#   .\run-sanity.ps1 -CheckOnly     (only shows which Node it would use, runs nothing)
#
# It finds Node.js by itself, on whoever's machine it is: first the "node" already on your
# PATH, then a portable Node folder in YOUR OWN user profile (for example
# C:\Users\<your user name>\AppData\Local\nodejs-portable\node-v24.18.0-win-x64). Nothing here
# is tied to one person's folder. Keep this file ASCII-only (Windows PowerShell 5.1 reads it
# as ANSI).
param([switch]$CheckOnly)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Find-NodeDir {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return (Split-Path $cmd.Source) }
    $roots = @(
        (Join-Path $env:LOCALAPPDATA "nodejs-portable"),
        (Join-Path $env:USERPROFILE "nodejs-portable"),
        (Join-Path $env:USERPROFILE "nodejs"),
        (Join-Path $env:LOCALAPPDATA "Programs\nodejs")
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        if (Test-Path (Join-Path $root "node.exe")) { return $root }
        $hit = Get-ChildItem $root -Directory -Filter "node-v*-win-x64" -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName "node.exe") } |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

$nodeDir = Find-NodeDir
if (-not $nodeDir) {
    Write-Host ""
    Write-Host "Node.js was not found." -ForegroundColor Red
    Write-Host "Unzip a portable Node (nodejs.org, Windows zip) into $env:LOCALAPPDATA\nodejs-portable"
    Write-Host "or add your Node folder to PATH, then run this again. See the wiki: Setup without Claude and without IT."
    Write-Host ""
    Write-Host "Press Enter to close..." -NoNewline
    Read-Host
    exit 1
}
$env:Path = "$nodeDir;$env:Path"
Write-Host "Using Node from: $nodeDir"
if ($CheckOnly) { & node -v; exit 0 }

$npm = Join-Path $nodeDir "npm.cmd"
if (-not (Test-Path $npm)) { $npm = "npm" }
& $npm run sanity
Write-Host ""
Write-Host "Press Enter to close..." -NoNewline
Read-Host
