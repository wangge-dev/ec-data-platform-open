[CmdletBinding()]
param(
  [string]$OutputRoot,
  [switch]$IncludeDatabaseBackup,
  [string]$PostgresContainerName = 'ec-data-postgres'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'sha256.ps1')
if (-not $OutputRoot) { $OutputRoot = Join-Path $RepoRoot 'release' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
$pathRoot = [IO.Path]::GetPathRoot($OutputRoot).TrimEnd('\')
if ($OutputRoot.Equals($pathRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputRoot cannot be a filesystem root: $OutputRoot"
}
if ($PostgresContainerName -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') {
  throw "Invalid Postgres container name: $PostgresContainerName"
}

$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$date = Get-Date -Format 'yyyyMMdd'
$name = "ec-data-platform-development-$date"
$stagingRoot = Join-Path $OutputRoot ('.handoff-' + [Guid]::NewGuid().ToString('N'))
$payloadRoot = Join-Path $stagingRoot $name
$zipTemp = Join-Path $stagingRoot ($name + '.zip')
$zipFinal = Join-Path $OutputRoot ($name + '.zip')
$containerDump = "/tmp/ec-data-platform-$([Guid]::NewGuid().ToString('N')).dump"

function Invoke-Native([string]$File, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $File @Arguments *> $null
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previous
  }
  if ($exitCode -ne 0) { throw "$File failed with exit code $exitCode" }
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, $script:Utf8NoBom)
}

New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null

try {
  $status = @(& git -C $RepoRoot status --porcelain --untracked-files=normal)
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the source worktree.' }
  if ($status.Count -gt 0) {
    throw 'Refusing to create a development handoff from a dirty worktree.'
  }

  $head = (& git -C $RepoRoot rev-parse HEAD).Trim()
  $main = (& git -C $RepoRoot rev-parse main).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $head -or -not $main) {
    throw 'Could not resolve HEAD and main.'
  }
  if ($head -ne $main) {
    throw "Current HEAD ($head) is not the canonical main revision ($main)."
  }

  Invoke-Native git @('-C', $RepoRoot, 'fsck', '--full')

  $bundlePath = Join-Path $payloadRoot "$name.bundle"
  Invoke-Native git @('-C', $RepoRoot, 'bundle', 'create', $bundlePath, 'main')
  Invoke-Native git @('-C', $RepoRoot, 'bundle', 'verify', $bundlePath)

  $databasePath = $null
  if ($IncludeDatabaseBackup) {
    $containerRunning = (
      & docker inspect --format '{{.State.Running}}' $PostgresContainerName 2>$null
    ).Trim()
    if ($LASTEXITCODE -ne 0 -or $containerRunning -ne 'true') {
      throw "Postgres container is missing or not running: $PostgresContainerName"
    }
    try {
      Invoke-Native docker @(
        'exec', $PostgresContainerName,
        'pg_dump', '-U', 'ec', '-d', 'ec_data',
        '--format=custom', '--no-owner', '--no-acl',
        '--file', $containerDump
      )
      $databasePath = Join-Path $payloadRoot 'ec_data.dump'
      Invoke-Native docker @('cp', "${PostgresContainerName}:$containerDump", $databasePath)
      Invoke-Native docker @(
        'exec', $PostgresContainerName,
        'pg_restore', '--list', $containerDump
      )
    }
    finally {
      & docker exec $PostgresContainerName rm -f $containerDump *> $null
    }
  }

  $restore = @'
# Development handoff restore

## Restore the source

```powershell
git clone .\{{BUNDLE_NAME}}.bundle ec-data-platform
Set-Location ec-data-platform
pnpm install --frozen-lockfile
```

Copy `.env` through a separate secure channel, or recreate it from
`deploy/.env.example`. The environment file is not included in this package.

## Start a clean environment

```powershell
Copy-Item deploy/.env.example deploy/.env
# Edit deploy/.env first.
Set-Location deploy
docker compose up -d
docker compose ps -a
```

## Restore the database

If this package contains `ec_data.dump`, stop the API from `deploy/` and run:

```powershell
docker compose stop api
docker cp ..\ec_data.dump ec-data-postgres:/tmp/ec_data.dump
docker compose exec -T postgres pg_restore -U ec -d ec_data --clean --if-exists --no-owner --no-acl /tmp/ec_data.dump
docker compose up -d --force-recreate migrate
docker compose up -d api web
docker compose ps -a
```

After restore, verify `/api/health`, admin login, modules, data sources, and
boards. The database dump contains real business data. Never commit or share it
publicly.

The restored database keeps the existing administrator password hash.
`ADMIN_PASSWORD` only seeds an administrator when none exists; it does not reset
the restored account. Sign in with the old password, then change it immediately
from Settings.
'@
  $restore = $restore.Replace('{{BUNDLE_NAME}}', $name)
  Write-Utf8NoBom (Join-Path $payloadRoot 'RESTORE.md') $restore

  $files = @(
    Get-ChildItem -LiteralPath $payloadRoot -File | ForEach-Object {
      [ordered]@{
        name = $_.Name
        bytes = $_.Length
        sha256 = (Get-Sha256Hex $_.FullName).ToUpperInvariant()
      }
    }
  )
  $manifest = [ordered]@{
    name = $name
    createdAt = (Get-Date).ToString('o')
    sourceRevision = $main
    databaseIncluded = [bool]$IncludeDatabaseBackup
    files = $files
  }
  Write-Utf8NoBom (
    Join-Path $payloadRoot 'development-handoff-manifest.json'
  ) ($manifest | ConvertTo-Json -Depth 5)

  Compress-Archive -Path $payloadRoot -DestinationPath $zipTemp -CompressionLevel Optimal
  Move-Item -LiteralPath $zipTemp -Destination $zipFinal -Force
  $zipHash = (Get-Sha256Hex $zipFinal).ToUpperInvariant()
  $zipBytes = (Get-Item -LiteralPath $zipFinal).Length
}
finally {
  if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}

Write-Host "Development handoff ZIP: $zipFinal"
Write-Host "Database included: $([bool]$IncludeDatabaseBackup)"
Write-Host "Bytes: $zipBytes"
Write-Host "SHA-256: $zipHash"
