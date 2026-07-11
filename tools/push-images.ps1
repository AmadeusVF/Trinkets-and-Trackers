param(
    [string]$Message = "",
    [string]$Remote = "origin",
    [string]$Branch = "main",
    [switch]$ForceWithLease
)

$ErrorActionPreference = "Stop"

function Stop-IfNotRepo {
    git rev-parse --is-inside-work-tree *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "This script must be run from inside the Trinkets & Trackers git repository."
    }
}

Stop-IfNotRepo

if (-not (Test-Path -LiteralPath "images")) {
    New-Item -ItemType Directory -Force -Path "images" | Out-Null
}

git add -A -- images

$pending = git diff --cached --name-only -- images
if (-not $pending) {
    Write-Host "No image changes to push."
    exit 0
}

if ([string]::IsNullOrWhiteSpace($Message)) {
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
    $Message = "Update images $stamp"
}

git commit -m $Message

if ($ForceWithLease) {
    git push --force-with-lease $Remote "HEAD:$Branch"
} else {
    git push $Remote "HEAD:$Branch"
}
