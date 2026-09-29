[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath,

  [Parameter(Mandatory = $true)]
  [string]$ConfirmInstanceId,

  [switch]$AcknowledgeDataOverwrite,

  [switch]$AcknowledgeReleaseMismatch
)

$ErrorActionPreference = 'Stop'
$script:ContainerDumpPath = $null
$script:MutationStarted = $false
$script:RestoreHealthy = $false

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
    throw 'deploy/.env is required before an instance restore can run.'
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
  if ($instanceIdValues.Count -ne 1) { throw 'INSTANCE_ID must appear exactly once in deploy/.env.' }
  $instanceId = [string]$instanceIdValues[0]
  if ($instanceId -cnotmatch '^[a-z0-9][a-z0-9_-]{2,62}$' -or $instanceId.StartsWith('change_me')) {
    throw 'INSTANCE_ID must be a unique 3-63 character lowercase identifier, not a change_me placeholder.'
  }
  return $instanceId
}

function Get-ReleaseRevision {
  if (Test-Path -LiteralPath (Join-Path $RuntimeRoot '.git')) {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return 'unknown' }
    $statusLines = @(& git -C $RuntimeRoot status --porcelain --untracked-files=normal 2>$null)
    if ($LASTEXITCODE -ne 0 -or $statusLines.Count -gt 0) { return 'unknown' }
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

function Read-BackupManifest([string]$Path) {
  $keys = @(
    'schemaVersion', 'createdAt', 'sourceInstanceId', 'sourceReleaseRevision',
    'database', 'format', 'containsBusinessData', 'containsSecrets',
    'environmentIncluded', 'redisIncluded', 'fileName', 'fileBytes', 'fileSha256'
  )
  $lines = [IO.File]::ReadAllLines($Path)
  if ($lines.Count -ne $keys.Count) { throw 'Backup manifest does not match instance-backup/v1.' }
  $values = [ordered]@{}
  for ($index = 0; $index -lt $keys.Count; $index++) {
    $prefix = $keys[$index] + '='
    if (-not $lines[$index].StartsWith($prefix, [StringComparison]::Ordinal)) {
      throw "Backup manifest key order or syntax is invalid at $($keys[$index])."
    }
    $values[$keys[$index]] = $lines[$index].Substring($prefix.Length)
  }
  if ($values.schemaVersion -cne 'instance-backup/v1' -or
      $values.database -cne 'ec_data' -or $values.format -cne 'postgres-custom' -or
      $values.containsBusinessData -cne 'true' -or $values.containsSecrets -cne 'true' -or
      $values.environmentIncluded -cne 'false' -or $values.redisIncluded -cne 'false' -or
      $values.fileName -cne 'ec_data.dump') {
    throw 'Backup manifest declares an unsupported or unsafe backup contract.'
  }
  if ([string]$values.sourceInstanceId -cnotmatch '^[a-z0-9][a-z0-9_-]{2,62}$') {
    throw 'Backup manifest sourceInstanceId is invalid.'
  }
  if ([string]$values.sourceReleaseRevision -cnotmatch '^(unknown|[0-9a-f]{40})$') {
    throw 'Backup manifest sourceReleaseRevision is invalid.'
  }
  if ([string]$values.fileSha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Backup manifest fileSha256 is invalid.'
  }
  [UInt64]$bytes = 0
  if (-not [UInt64]::TryParse(
    [string]$values.fileBytes,
    [Globalization.NumberStyles]::None,
    [Globalization.CultureInfo]::InvariantCulture,
    [ref]$bytes
  ) -or $bytes -eq 0) {
    throw 'Backup manifest fileBytes is invalid.'
  }
  [DateTimeOffset]$parsedTimestamp = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParseExact(
    [string]$values.createdAt,
    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal,
    [ref]$parsedTimestamp
  )) {
    throw 'Backup manifest createdAt is not a canonical UTC timestamp.'
  }
  return [pscustomobject]@{
    SourceInstanceId = [string]$values.sourceInstanceId
    SourceReleaseRevision = [string]$values.sourceReleaseRevision
    FileBytes = $bytes
    FileSha256 = [string]$values.fileSha256
  }
}

function Resolve-BackupDirectory([string]$Candidate) {
  if (-not (Test-Path -LiteralPath $Candidate -PathType Container)) {
    throw 'BackupPath must be an existing instance backup directory.'
  }
  $rootItem = Get-Item -LiteralPath $Candidate -Force
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'BackupPath must not be a reparse point or symbolic link.'
  }
  $entries = @(Get-ChildItem -LiteralPath $rootItem.FullName -Force)
  $expected = @('backup-manifest.txt', 'ec_data.dump')
  $actual = @($entries | ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
  if ($entries.Count -ne 2 -or
      [string]::Join("`n", $actual) -cne [string]::Join("`n", ($expected | Sort-Object -CaseSensitive))) {
    throw 'BackupPath must contain exactly backup-manifest.txt and ec_data.dump.'
  }
  foreach ($entry in $entries) {
    if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Backup entry must be a regular file: $($entry.Name)"
    }
  }
  return (Resolve-Path -LiteralPath $rootItem.FullName).Path
}

function Get-ServiceState([string]$Service, [string[]]$Compose) {
  $containerId = Get-UniqueNativeLine `
    (Invoke-NativeLines docker ($Compose + @('ps', '--all', '-q', $Service))) `
    '^[0-9a-f]{12,64}$' "Compose service $Service container ID"
  $state = Get-UniqueNativeLine `
    (Invoke-NativeLines docker @(
      'inspect', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.ExitCode}}', $containerId
    )) '^[^|]+\|[^|]*\|[0-9]+$' "Compose service $Service state"
  $parts = $state.Split('|')
  return [pscustomobject]@{ Status = $parts[0]; Health = $parts[1]; ExitCode = [int]$parts[2] }
}

function Wait-RestoredInstance([string[]]$Compose, [int]$TimeoutSeconds = 180) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $ready = $true
    foreach ($service in @('postgres', 'redis', 'api', 'web')) {
      $state = Get-ServiceState $service $Compose
      if ($state.Status -in @('exited', 'dead') -or $state.Health -eq 'unhealthy') {
        throw "Restored service $service failed: status=$($state.Status), health=$($state.Health), exit=$($state.ExitCode)"
      }
      if ($state.Status -cne 'running' -or $state.Health -cne 'healthy') { $ready = $false }
    }
    $migrate = Get-ServiceState 'migrate' $Compose
    if ($migrate.Status -ceq 'exited' -and $migrate.ExitCode -ne 0) {
      throw "Post-restore migration failed with exit code $($migrate.ExitCode)."
    }
    if ($ready -and $migrate.Status -ceq 'exited' -and $migrate.ExitCode -eq 0) { return }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw 'Timed out waiting for post-restore migration and service health.'
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

if (-not $AcknowledgeDataOverwrite) {
  throw 'Restore requires -AcknowledgeDataOverwrite because it replaces the target database.'
}
Assert-NoProcessComposeOverrides
if (-not (Test-Path -LiteralPath $ComposePath -PathType Leaf)) { throw "Compose file is missing: $ComposePath" }
$targetInstanceId = Read-InstanceId $EnvironmentPath
if ($ConfirmInstanceId -cne $targetInstanceId) {
  throw "ConfirmInstanceId must exactly match target INSTANCE_ID '$targetInstanceId'."
}
$safeBackupPath = Resolve-BackupDirectory $BackupPath
$manifest = Read-BackupManifest (Join-Path $safeBackupPath 'backup-manifest.txt')
$dumpPath = Join-Path $safeBackupPath 'ec_data.dump'
$dump = Get-Item -LiteralPath $dumpPath -Force
if ([UInt64]$dump.Length -ne $manifest.FileBytes) { throw 'Backup dump byte count does not match its manifest.' }
$actualHash = Get-Sha256Hex $dumpPath
if ($actualHash -cne $manifest.FileSha256) { throw 'Backup dump SHA-256 does not match its manifest.' }
$targetRevision = Get-ReleaseRevision
$releaseMismatch = $manifest.SourceReleaseRevision -ceq 'unknown' -or $targetRevision -ceq 'unknown' -or
  $manifest.SourceReleaseRevision -cne $targetRevision
if ($releaseMismatch -and -not $AcknowledgeReleaseMismatch) {
  throw "Backup revision '$($manifest.SourceReleaseRevision)' and target revision '$targetRevision' are not proven identical. Review compatibility and pass -AcknowledgeReleaseMismatch."
}

Get-Command docker -ErrorAction Stop | Out-Null
$script:ContainerDumpPath = "/tmp/ec-data-instance-restore-$([Guid]::NewGuid().ToString('N')).dump"
try {
  Push-Location $DeployRoot
  try {
    $compose = @('compose', '--env-file', '.env', '-f', 'docker-compose.yml')
    Invoke-Native docker ($compose + @('config', '--quiet'))
    $postgresId = Get-UniqueNativeLine `
      (Invoke-NativeLines docker ($compose + @('ps', '--all', '-q', 'postgres'))) `
      '^[0-9a-f]{12,64}$' 'PostgreSQL container ID'
    $running = Get-UniqueNativeLine `
      (Invoke-NativeLines docker @('inspect', '--format', '{{.State.Running}}', $postgresId)) `
      '^(true|false)$' 'PostgreSQL running state'
    if ($running -cne 'true') { throw 'PostgreSQL must be running before restore.' }

    Invoke-Native docker @('cp', $dumpPath, "${postgresId}:$script:ContainerDumpPath")
    Invoke-Native docker ($compose + @('exec', '-T', 'postgres', 'pg_restore', '--list', $script:ContainerDumpPath))

    Invoke-Native docker ($compose + @('stop', 'api', 'migrate'))
    $script:MutationStarted = $true
    Invoke-Native docker ($compose + @('exec', '-T', 'postgres', 'dropdb', '-U', 'ec', '--if-exists', '--force', 'ec_data'))
    Invoke-Native docker ($compose + @('exec', '-T', 'postgres', 'createdb', '-U', 'ec', '-O', 'ec', 'ec_data'))
    Invoke-Native docker ($compose + @(
      'exec', '-T', 'postgres', 'pg_restore', '-U', 'ec', '-d', 'ec_data',
      '--no-owner', '--no-acl', '--exit-on-error', $script:ContainerDumpPath
    ))
    Invoke-Native docker ($compose + @('exec', '-T', 'redis', 'redis-cli', 'FLUSHDB'))
    Invoke-Native docker ($compose + @('up', '-d', '--no-build', '--force-recreate', 'migrate', 'api', 'web'))
    Wait-RestoredInstance $compose
    $script:RestoreHealthy = $true
  }
  finally { Pop-Location }

  Write-Output "Restored source instance '$($manifest.SourceInstanceId)' into target '$targetInstanceId'."
  Write-Output "Verified SHA-256: $actualHash"
  Write-Warning 'deploy/.env was not restored. Keep the target secrets, and retain the original ENCRYPTION_KEY if restored connector credentials must remain decryptable.'
}
catch {
  if ($script:MutationStarted -and -not $script:RestoreHealthy) {
    try {
      Push-Location $DeployRoot
      try { & docker compose --env-file .env -f docker-compose.yml stop api migrate 2>$null }
      finally { Pop-Location }
    }
    catch { }
    Write-Warning 'Restore did not complete; API and migrate were stopped to fail closed. Inspect PostgreSQL and restore a verified backup before restarting.'
  }
  throw
}
finally { Remove-ContainerDump }
