[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:ContainerDumpPath = $null
$script:StagingPath = $null

function Get-RuntimeRoot {
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'deploy\docker-compose.yml') -PathType Leaf) {
    return (Resolve-Path -LiteralPath $PSScriptRoot).Path
  }
  return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}

$RuntimeRoot = Get-RuntimeRoot
$DeployRoot = Join-Path $RuntimeRoot 'deploy'
$EnvironmentPath = Join-Path $DeployRoot '.env'
$ComposePath = Join-Path $DeployRoot 'docker-compose.yml'
$Sha256Helper = Join-Path $PSScriptRoot 'sha256.ps1'
if (-not (Test-Path -LiteralPath $Sha256Helper -PathType Leaf)) {
  throw "SHA-256 helper is missing: $Sha256Helper"
}
. (Join-Path $PSScriptRoot 'sha256.ps1')

function Invoke-Native([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}

function Invoke-NativeLines([string]$File, [string[]]$Arguments) {
  $lines = @(& $File @Arguments)
  if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
  return @($lines | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
}

function Get-UniqueNativeLine([string[]]$Lines, [string]$Pattern, [string]$Label) {
  $values = @($Lines | Where-Object { $_ })
  if ($values.Count -ne 1 -or [string]$values[0] -cnotmatch $Pattern) {
    throw "$Label did not return one canonical value."
  }
  return [string]$values[0]
}

function Assert-NoProcessComposeOverrides {
  $override = @(Get-ChildItem Env: | Where-Object {
    $_.Name -like 'COMPOSE_*' -or $_.Name -like 'DOCKER_*'
  } | Select-Object -First 1)
  if ($override.Count -gt 0) {
    throw "Refusing process-level Docker/Compose target override: $($override[0].Name)"
  }
}

function Read-InstanceId([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw 'deploy/.env is required before an instance backup can run.'
  }
  # PowerShell variable names are case-insensitive. Do not call this $matches:
  # every -match expression updates the automatic $Matches variable.
  $instanceIdValues = [Collections.Generic.List[string]]::new()
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    $text = [string]$line
    if (-not $text.Trim() -or $text.TrimStart().StartsWith('#')) { continue }
    $separator = $text.IndexOf('=')
    if ($separator -lt 1) { continue }
    $rawName = $text.Substring(0, $separator)
    $name = $rawName.Trim()
    if ($name -match '^DOCKER_' -or ($name -match '^COMPOSE_' -and $name -cne 'COMPOSE_PROJECT_NAME')) {
      throw "deploy/.env contains a forbidden Docker Compose control variable: $name"
    }
    if ($name -ceq 'COMPOSE_PROJECT_NAME') {
      $projectName = $text.Substring($separator + 1)
      if ($rawName -cne $name -or $projectName -cnotmatch '^[a-z0-9][a-z0-9_-]{0,62}$') {
        throw 'COMPOSE_PROJECT_NAME must use the exact unquoted NAME=VALUE form and a safe lowercase value.'
      }
    }
    if ($name -cne 'INSTANCE_ID') { continue }
    if ($rawName -cne 'INSTANCE_ID') {
      throw 'INSTANCE_ID must use the exact unquoted INSTANCE_ID=value form in deploy/.env.'
    }
    $instanceIdValues.Add($text.Substring($separator + 1)) | Out-Null
  }
  if ($instanceIdValues.Count -ne 1) {
    throw 'INSTANCE_ID must appear exactly once in deploy/.env.'
  }
  $instanceId = [string]$instanceIdValues[0]
  if ($instanceId -cnotmatch '^[a-z0-9][a-z0-9_-]{2,62}$' -or $instanceId.StartsWith('change_me')) {
    throw 'INSTANCE_ID must be a unique 3-63 character lowercase identifier, not a change_me placeholder.'
  }
  return $instanceId
}

function Resolve-SafeOutputRoot([string]$Candidate) {
  if (-not (Test-Path -LiteralPath $Candidate -PathType Container)) {
    throw 'OutputRoot must be an existing backup directory outside this runtime package.'
  }
  $item = Get-Item -LiteralPath $Candidate -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'OutputRoot must not be a reparse point or symbolic link.'
  }
  $resolved = (Resolve-Path -LiteralPath $item.FullName).Path.TrimEnd('\', '/')
  $pathRoot = [IO.Path]::GetPathRoot($resolved).TrimEnd('\', '/')
  if ($resolved.Equals($pathRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputRoot cannot be a filesystem root.'
  }
  $runtime = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\', '/')
  if ($resolved.Equals($runtime, [StringComparison]::OrdinalIgnoreCase) -or
      $resolved.StartsWith($runtime + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputRoot must be outside the source tree or extracted offline runtime.'
  }
  return $resolved
}

function Get-ReleaseRevision {
  if (Test-Path -LiteralPath (Join-Path $RuntimeRoot '.git')) {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
      throw 'Cannot verify source revision because git is unavailable.'
    }
    $statusLines = @(& git -C $RuntimeRoot status --porcelain --untracked-files=normal 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify whether the source worktree is clean.' }
    if ($statusLines.Count -gt 0) {
      throw 'Refusing to create a revision-labelled backup from a dirty source worktree.'
    }
  }
  $manifestPath = Join-Path $RuntimeRoot 'release-manifest.json'
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    try {
      $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
      $revision = [string]$manifest.sourceRevision
      if ($revision -cmatch '^[0-9a-f]{40}$') { return $revision }
    }
    catch { }
  }
  if ((Test-Path -LiteralPath (Join-Path $RuntimeRoot '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
    $revisionLines = @(& git -C $RuntimeRoot rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $revisionLines.Count -eq 1) {
      $revision = ([string]$revisionLines[0]).Trim()
      if ($revision -cmatch '^[0-9a-f]{40}$') { return $revision }
    }
  }
  return 'unknown'
}

function Remove-ContainerDump {
  if (-not $script:ContainerDumpPath) { return }
  try {
    Push-Location $DeployRoot
    try {
      & docker compose --env-file .env -f docker-compose.yml exec -T postgres rm -f -- $script:ContainerDumpPath 2>$null
    }
    finally { Pop-Location }
  }
  catch { }
  $script:ContainerDumpPath = $null
}

Assert-NoProcessComposeOverrides
if (-not (Test-Path -LiteralPath $ComposePath -PathType Leaf)) {
  throw "Compose file is missing: $ComposePath"
}
$instanceId = Read-InstanceId $EnvironmentPath
$safeOutputRoot = Resolve-SafeOutputRoot $OutputRoot
$revision = Get-ReleaseRevision
$timestamp = [DateTime]::UtcNow
$createdAt = $timestamp.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
$nameTimestamp = $timestamp.ToString("yyyyMMdd'T'HHmmss'Z'", [Globalization.CultureInfo]::InvariantCulture)
$backupName = "ec-data-instance-backup-$instanceId-$nameTimestamp"
$finalPath = Join-Path $safeOutputRoot $backupName
$stagingName = ".$backupName-$([Guid]::NewGuid().ToString('N').Substring(0, 12)).staging"
$script:StagingPath = Join-Path $safeOutputRoot $stagingName
if (Test-Path -LiteralPath $finalPath) { throw "Backup already exists: $finalPath" }
if (Test-Path -LiteralPath $script:StagingPath) { throw "Backup staging path already exists: $script:StagingPath" }

Get-Command docker -ErrorAction Stop | Out-Null
New-Item -Path $script:StagingPath -ItemType Directory | Out-Null
$dumpPath = Join-Path $script:StagingPath 'ec_data.dump'
$manifestPath = Join-Path $script:StagingPath 'backup-manifest.txt'
$script:ContainerDumpPath = "/tmp/ec-data-instance-backup-$([Guid]::NewGuid().ToString('N')).dump"

try {
  Push-Location $DeployRoot
  try {
    $compose = @('compose', '--env-file', '.env', '-f', 'docker-compose.yml')
    Invoke-Native docker ($compose + @('config', '--quiet'))
    $containerId = Get-UniqueNativeLine `
      (Invoke-NativeLines docker ($compose + @('ps', '--all', '-q', 'postgres'))) `
      '^[0-9a-f]{12,64}$' 'PostgreSQL container ID'
    $running = Get-UniqueNativeLine `
      (Invoke-NativeLines docker @('inspect', '--format', '{{.State.Running}}', $containerId)) `
      '^(true|false)$' 'PostgreSQL running state'
    if ($running -cne 'true') { throw 'PostgreSQL must be running before backup.' }

    Invoke-Native docker ($compose + @(
      'exec', '-T', 'postgres',
      'pg_dump', '-U', 'ec', '-d', 'ec_data', '--format=custom', '--compress=6',
      '--no-owner', '--no-acl', '--file', $script:ContainerDumpPath
    ))
    Invoke-Native docker ($compose + @(
      'exec', '-T', 'postgres', 'pg_restore', '--list', $script:ContainerDumpPath
    ))
    Invoke-Native docker @('cp', "${containerId}:$script:ContainerDumpPath", $dumpPath)
  }
  finally { Pop-Location }

  $dump = Get-Item -LiteralPath $dumpPath -Force
  if ($dump.PSIsContainer -or $dump.Length -le 0) { throw 'PostgreSQL produced an empty or invalid dump.' }
  $dumpHash = Get-Sha256Hex $dumpPath
  $manifestLines = @(
    'schemaVersion=instance-backup/v1',
    "createdAt=$createdAt",
    "sourceInstanceId=$instanceId",
    "sourceReleaseRevision=$revision",
    'database=ec_data',
    'format=postgres-custom',
    'containsBusinessData=true',
    'containsSecrets=true',
    'environmentIncluded=false',
    'redisIncluded=false',
    'fileName=ec_data.dump',
    "fileBytes=$($dump.Length)",
    "fileSha256=$dumpHash"
  )
  [IO.File]::WriteAllText($manifestPath, ([string]::Join("`n", $manifestLines) + "`n"), $script:Utf8NoBom)

  Remove-ContainerDump
  [IO.Directory]::Move($script:StagingPath, $finalPath)
  $script:StagingPath = $null
  Write-Output "Backup directory: $finalPath"
  Write-Output "Bytes: $($dump.Length)"
  Write-Output "SHA-256: $dumpHash"
  Write-Warning 'This backup contains business data and sensitive database material. Store it encrypted and separately from the runtime package.'
}
finally {
  Remove-ContainerDump
  if ($script:StagingPath -and (Test-Path -LiteralPath $script:StagingPath -PathType Container)) {
    $expectedPrefix = [IO.Path]::GetFullPath($safeOutputRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $stagingFull = [IO.Path]::GetFullPath($script:StagingPath)
    if ($stagingFull.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($stagingFull) -cmatch '^\.ec-data-instance-backup-[a-z0-9_-]+-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.staging$') {
      Remove-Item -LiteralPath $stagingFull -Recurse -Force
    }
  }
}
