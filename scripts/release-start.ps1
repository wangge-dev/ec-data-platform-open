[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'sha256.ps1')
$parentRoot = Split-Path -Parent $PSScriptRoot
if ((Test-Path -LiteralPath (Join-Path $PSScriptRoot 'release-manifest.json') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'deploy') -PathType Container)) {
  $ReleaseRoot = $PSScriptRoot
}
elseif ((Test-Path -LiteralPath (Join-Path $parentRoot 'release-manifest.json') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $parentRoot 'deploy') -PathType Container)) {
  $ReleaseRoot = $parentRoot
}
else { throw 'Could not locate the extracted release root.' }
$DeployRoot = Join-Path $ReleaseRoot 'deploy'
$ImageArchive = Join-Path $ReleaseRoot 'ec-data-images.tar'
$ManifestPath = Join-Path $ReleaseRoot 'release-manifest.json'
$ImageIdContractPath = Join-Path $ReleaseRoot 'release-image-ids.txt'
$Images = @('postgres:16', 'redis:7-alpine', 'deploy-api:latest', 'deploy-web:latest')

function Invoke-Native([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}

function Invoke-NativeCapture([string]$File, [string[]]$Arguments) {
  $previousErrorActionPreference = $ErrorActionPreference
  $stderrPath = Join-Path ([IO.Path]::GetTempPath()) ('ec-release-stderr-' + [Guid]::NewGuid().ToString('N') + '.log')
  $stdOut = @()
  $stdErr = @()
  $exitCode = 1
  try {
    $ErrorActionPreference = 'Continue'
    $stdOut = @(& $File @Arguments 2> $stderrPath | ForEach-Object { [string]$_ })
    $exitCode = $LASTEXITCODE
    if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
      $stdErr = @(
        Get-Content -LiteralPath $stderrPath |
          ForEach-Object { ([string]$_).Trim() } |
          Where-Object { $_ }
      )
    }
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  }
  return [pscustomobject]@{
    ExitCode = $exitCode
    StdOut = $stdOut
    StdErr = $stdErr
    Output = @($stdOut) + @($stdErr)
  }
}

function Get-UniqueNativeLine(
  [object[]]$Lines,
  [string]$Pattern,
  [string]$Description
) {
  $values = @($Lines | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  if ($values.Count -ne 1 -or $values[0] -cnotmatch $Pattern) {
    throw "$Description did not return exactly one valid line."
  }
  return [string]$values[0]
}

function Read-StrictReleaseSecret([string]$Path, [string]$Name) {
  $candidates = [Collections.Generic.List[string]]::new()
  foreach ($line in Get-Content -LiteralPath $Path) {
    $text = ([string]$line).TrimEnd("`r")
    if (-not $text.Trim() -or $text.TrimStart().StartsWith('#')) { continue }
    $separator = $text.IndexOf('=')
    if ($separator -lt 0) { continue }
    $rawName = $text.Substring(0, $separator)
    if ($rawName.Trim() -cne $Name) { continue }
    if ($rawName -cne $Name) {
      throw "$Name must use the exact unquoted NAME=VALUE form in deploy/.env."
    }
    $candidates.Add($text.Substring($separator + 1)) | Out-Null
  }
  if ($candidates.Count -ne 1) {
    throw "$Name must appear exactly once as an unquoted NAME=VALUE entry in deploy/.env."
  }
  $value = [string]$candidates[0]
  if ($value -cnotmatch '^[A-Za-z0-9._~!%*+,:?@^/=&-]+$') {
    throw "$Name must be an unquoted ASCII token without whitespace, comments, interpolation, quotes, or backslashes."
  }
  if (
    $Name -in @('POSTGRES_PASSWORD', 'APP_DB_PASSWORD') -and
    $value -cnotmatch '^[A-Za-z0-9._~-]+$'
  ) {
    throw "$Name is embedded in a PostgreSQL URI and may contain only letters, digits, dot, underscore, tilde, or hyphen."
  }
  return $value
}

function Assert-ReleaseEnvironment([string]$Path) {
  $minimumLengths = @{
    POSTGRES_PASSWORD = 12
    APP_DB_PASSWORD = 12
    ADMIN_PASSWORD = 12
    JWT_SECRET = 32
  }
  $values = @{}
  $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
  foreach ($line in [IO.File]::ReadAllLines($Path, $strictUtf8)) {
    if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line) -or $line -notmatch '=') { continue }
    $name = $line.Substring(0, $line.IndexOf('=')).Trim()
    if ($name -match '^DOCKER_' -or ($name -match '^COMPOSE_' -and $name -cne 'COMPOSE_PROJECT_NAME')) {
      throw "deploy/.env contains a forbidden Docker Compose control variable: $name"
    }
    if ($name -ceq 'COMPOSE_PROJECT_NAME' -and $line.Substring($line.IndexOf('=') + 1) -cnotmatch '^[a-z0-9][a-z0-9_-]{0,62}$') {
      throw 'COMPOSE_PROJECT_NAME must use a safe lowercase project name.'
    }
  }
  foreach ($name in $minimumLengths.Keys) {
    $value = Read-StrictReleaseSecret -Path $Path -Name $name
    $values[$name] = $value
    if (-not $value -or $value -match '^change_me' -or $value.Length -lt $minimumLengths[$name]) {
      throw "$name must be replaced with a unique value of at least $($minimumLengths[$name]) characters."
    }
  }
  $secretValues = @($minimumLengths.Keys | ForEach-Object { [string]$values[$_] })
  if (@($secretValues | Sort-Object -CaseSensitive -Unique).Count -ne $secretValues.Count) {
    throw 'POSTGRES_PASSWORD, APP_DB_PASSWORD, ADMIN_PASSWORD, and JWT_SECRET must be different values.'
  }
}

function Read-ImageIdContract([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Release image-ID contract was not found: $Path"
  }
  try {
    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $lines = [IO.File]::ReadAllLines($Path, $strictUtf8)
  }
  catch {
    throw "Release image-ID contract is not valid UTF-8: $($_.Exception.Message)"
  }
  if ($lines.Count -ne $Images.Count) {
    throw 'Release image-ID contract must contain exactly four ordered entries.'
  }
  $expected = [ordered]@{}
  for ($index = 0; $index -lt $Images.Count; $index++) {
    $prefix = $Images[$index] + '='
    $line = [string]$lines[$index]
    if (-not $line.StartsWith($prefix, [StringComparison]::Ordinal)) {
      throw "Release image-ID contract entry $($index + 1) has the wrong image or format."
    }
    $imageId = $line.Substring($prefix.Length)
    if ($imageId -cnotmatch '^sha256:[0-9a-f]{64}$') {
      throw "Release image-ID contract has an invalid image ID for $($Images[$index])."
    }
    $expected[$Images[$index]] = $imageId
  }
  return $expected
}

function Test-CanonicalUtcJsonTimestamp([string]$Json, [string]$PropertyName) {
  $regexOptions = [Text.RegularExpressions.RegexOptions]::CultureInvariant
  $propertyPattern = [regex]::Escape('"' + $PropertyName + '"') + '\s*:'
  if ([regex]::Matches($Json, $propertyPattern, $regexOptions).Count -ne 1) {
    return $false
  }
  $valuePattern = $propertyPattern + '\s*"(?<value>[^"\\]*)"'
  $valueMatch = [regex]::Match($Json, $valuePattern, $regexOptions)
  if (-not $valueMatch.Success) {
    return $false
  }
  $value = [string]$valueMatch.Groups['value'].Value
  if (-not [regex]::IsMatch(
    $value,
    '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$',
    $regexOptions
  )) {
    return $false
  }
  $parsed = [DateTimeOffset]::MinValue
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor
    [Globalization.DateTimeStyles]::AdjustToUniversal
  if (-not [DateTimeOffset]::TryParseExact(
    $value,
    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
    [Globalization.CultureInfo]::InvariantCulture,
    $styles,
    [ref]$parsed
  )) {
    return $false
  }
  return $parsed.ToUniversalTime().ToString(
    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
    [Globalization.CultureInfo]::InvariantCulture
  ) -ceq $value
}

function Read-ExpectedImageIds([string]$Path, [string]$ContractPath) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Release manifest was not found: $Path"
  }
  if ([IO.Path]::GetFileName($Path) -cne 'release-manifest.json') {
    throw 'Release manifest must use the canonical release-manifest.json file name.'
  }
  try {
    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $manifestJson = [IO.File]::ReadAllText($Path, $strictUtf8)
    foreach ($propertyName in @('name', 'createdAt', 'sourceRevision', 'imageSource', 'images', 'imageIds', 'files') + $Images) {
      $propertyPattern = [regex]::Escape('"' + $propertyName + '"') + '\s*:'
      if ([regex]::Matches($manifestJson, $propertyPattern).Count -ne 1) {
        throw "Release manifest must contain exactly one property named ${propertyName}."
      }
    }
    $manifest = $manifestJson | ConvertFrom-Json
  }
  catch {
    throw "Release manifest is not valid UTF-8 JSON: $($_.Exception.Message)"
  }

  if ($manifest -isnot [pscustomobject]) {
    throw 'Release manifest root must be a JSON object.'
  }
  $expectedRootProperties = @('name', 'createdAt', 'sourceRevision', 'imageSource', 'images', 'imageIds', 'files')
  $actualRootProperties = @($manifest.PSObject.Properties | ForEach-Object { $_.Name })
  if ($actualRootProperties.Count -ne $expectedRootProperties.Count -or
      [string]::Join("`n", $actualRootProperties) -cne [string]::Join("`n", $expectedRootProperties)) {
    throw 'Release manifest must contain exactly the canonical ordered root properties.'
  }

  $releaseRoot = [IO.Path]::GetFullPath((Split-Path -Parent $Path)).TrimEnd(
    [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  )
  if ([string]$manifest.name -cne [IO.Path]::GetFileName($releaseRoot)) {
    throw 'Release manifest name does not match the extracted release directory.'
  }
  if (-not (Test-CanonicalUtcJsonTimestamp -Json $manifestJson -PropertyName 'createdAt')) {
    throw 'Release manifest createdAt must be a canonical timestamp.'
  }
  if ([string]$manifest.sourceRevision -cnotmatch '^[0-9a-f]{40}$') {
    throw 'Release manifest sourceRevision must be a lowercase Git commit ID.'
  }
  if ([string]$manifest.imageSource -cnotmatch '^(local-build|prebuilt-archive)$') {
    throw 'Release manifest imageSource must identify a supported image source.'
  }

  $imagesProperty = $manifest.PSObject.Properties['images']
  $imageIdsProperty = $manifest.PSObject.Properties['imageIds']
  $filesProperty = $manifest.PSObject.Properties['files']
  if ($null -eq $imagesProperty -or $imagesProperty.Value -isnot [System.Array] -or
      $null -eq $imageIdsProperty -or $imageIdsProperty.Value -isnot [pscustomobject] -or
      $null -eq $filesProperty -or $filesProperty.Value -isnot [System.Array]) {
    throw 'Release manifest images/files must be arrays and imageIds must be an object.'
  }

  $manifestImages = @($manifest.images | ForEach-Object { [string]$_ })
  if ($manifestImages.Count -ne $Images.Count -or
      [string]::Join("`n", $manifestImages) -cne [string]::Join("`n", $Images)) {
    throw 'Release manifest images must exactly match the required image list.'
  }

  $properties = @($manifest.imageIds.PSObject.Properties)
  if ($properties.Count -ne $Images.Count) {
    throw 'Release manifest imageIds must contain exactly the required images.'
  }
  if ([string]::Join("`n", @($properties | ForEach-Object { $_.Name })) -cne [string]::Join("`n", $Images)) {
    throw 'Release manifest imageIds must use canonical image order.'
  }

  $expected = [ordered]@{}
  foreach ($image in $Images) {
    $matches = @($properties | Where-Object { $_.Name -ceq $image })
    if ($matches.Count -ne 1) {
      throw "Release manifest imageIds is missing or duplicates ${image}."
    }
    $imageId = [string]$matches[0].Value
    if ($imageId -cnotmatch '^sha256:[0-9a-f]{64}$') {
      throw "Release manifest has an invalid image ID for ${image}."
    }
    $expected[$image] = $imageId
  }
  $contract = Read-ImageIdContract $ContractPath
  foreach ($image in $Images) {
    if ([string]$contract[$image] -cne [string]$expected[$image]) {
      throw "Release manifest and image-ID contract disagree for ${image}."
    }
  }

  $listedFiles = @($manifest.files)
  if ($listedFiles.Count -eq 0) {
    throw 'Release manifest files must not be empty.'
  }
  $listedSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($entry in $listedFiles) {
    if ($entry -isnot [pscustomobject]) { throw 'Release manifest files contains a non-object entry.' }
    $entryProperties = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
    if ([string]::Join("`n", $entryProperties) -cne "path`nsize`nsha256") {
      throw 'Release manifest files entries must contain exactly path, size, and sha256 in canonical order.'
    }
    $relative = [string]$entry.path
    $parts = @($relative.Split('/'))
    if (-not $relative -or
        $relative -match '[\x00-\x1f\x7f\\]' -or
        $relative.StartsWith('/', [StringComparison]::Ordinal) -or
        $relative -match '^[A-Za-z]:' -or
        $parts.Count -eq 0 -or
        @($parts | Where-Object { -not $_ -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) {
      throw "Release manifest files contains an unsafe path: $relative"
    }
    if (-not $listedSet.Add($relative)) {
      throw "Release manifest files contains a duplicate path: $relative"
    }
    if ($entry.size -isnot [ValueType] -or [string]$entry.size -cnotmatch '^(0|[1-9][0-9]*)$' -or
        [int64]$entry.size -lt 0 -or [string]$entry.sha256 -cnotmatch '^[0-9a-f]{64}$') {
      throw "Release manifest files contains invalid size or SHA-256 metadata: $relative"
    }
  }

  $rootPrefix = $releaseRoot + [IO.Path]::DirectorySeparatorChar
  $rootAttributes = [IO.File]::GetAttributes($releaseRoot)
  if (($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Extracted release root must not be a reparse point: $releaseRoot"
  }
  $pendingDirectories = [Collections.Generic.Stack[string]]::new()
  $pendingDirectories.Push($releaseRoot)
  $actualFileList = [Collections.Generic.List[object]]::new()
  while ($pendingDirectories.Count -gt 0) {
    $currentDirectory = $pendingDirectories.Pop()
    foreach ($entryPath in [IO.Directory]::EnumerateFileSystemEntries($currentDirectory)) {
      $entryAttributes = [IO.File]::GetAttributes($entryPath)
      if (($entryAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Extracted release payload contains a reparse point: $entryPath"
      }
      if (($entryAttributes -band [IO.FileAttributes]::Directory) -ne 0) {
        $pendingDirectories.Push([IO.Path]::GetFullPath($entryPath))
        continue
      }
      $fullName = [IO.Path]::GetFullPath($entryPath)
      if (-not $fullName.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Extracted release payload escaped its root: $fullName"
      }
      $relative = $fullName.Substring($rootPrefix.Length).Replace('\', '/')
      if ($relative -ceq 'release-manifest.json' -or $relative -ceq 'deploy/.env') {
        continue
      }
      $actualFileList.Add([pscustomobject]@{
        path = $relative
        size = [int64](Get-Item -LiteralPath $fullName).Length
        sha256 = Get-Sha256Hex $fullName
      }) | Out-Null
    }
  }
  $listedSorted = @($listedFiles | Sort-Object { [string]$_.path })
  $actualSorted = @($actualFileList | Sort-Object { [string]$_.path })
  if ($listedSorted.Count -ne $actualSorted.Count) {
    throw 'Release manifest files does not exactly match the extracted payload.'
  }
  for ($index = 0; $index -lt $actualSorted.Count; $index++) {
    if ([string]$listedSorted[$index].path -cne [string]$actualSorted[$index].path -or
        [int64]$listedSorted[$index].size -ne [int64]$actualSorted[$index].size -or
        [string]$listedSorted[$index].sha256 -cne [string]$actualSorted[$index].sha256) {
      throw "Release manifest file integrity check failed: $([string]$actualSorted[$index].path)"
    }
  }
  return $expected
}

function Test-ArchiveManifestImageId([string]$Actual, [string]$Expected) {
  # Docker's classic store reports the config digest; containerd may report the
  # manifest digest. Resolve only through the already integrity-verified archive.
  if ($Actual -cnotmatch '^sha256:[0-9a-f]{64}$') { return $false }
  if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { return $false }
  $member = 'blobs/sha256/' + $Actual.Substring(7)
  $result = Invoke-NativeCapture tar @('-xOf', $ImageArchive, $member)
  if ($result.ExitCode -ne 0) { return $false }
  try {
    $manifest = ($result.StdOut -join "`n") | ConvertFrom-Json
    return $manifest.schemaVersion -eq 2 -and
      $manifest.mediaType -cin @('application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json') -and
      [string]$manifest.config.digest -ceq $Expected
  } catch { return $false }
}

function Assert-LoadedImageIds([System.Collections.IDictionary]$Expected) {
  $resolved = [ordered]@{}
  foreach ($image in $Images) {
    $result = Invoke-NativeCapture docker @('image', 'inspect', '--format', '{{.Id}}', $image)
    if ($result.ExitCode -ne 0) {
      throw "The release archive did not provide required image ${image}: $(($result.Output | Out-String).Trim())"
    }
    $actual = Get-UniqueNativeLine $result.StdOut '^sha256:[0-9a-f]{64}$' "Image inspect for ${image}"
    if ($actual -cne [string]$Expected[$image] -and
        -not (Test-ArchiveManifestImageId $actual ([string]$Expected[$image]))) {
      throw "Loaded image ID mismatch for ${image}: expected $($Expected[$image]), found $actual"
    }
    $resolved[$image] = $actual
  }
  return $resolved
}

function Assert-ComposeImageIds([System.Collections.IDictionary]$Expected) {
  $serviceImages = [ordered]@{
    postgres = 'postgres:16'
    redis = 'redis:7-alpine'
    migrate = 'deploy-api:latest'
    api = 'deploy-api:latest'
    web = 'deploy-web:latest'
  }
  foreach ($service in $serviceImages.Keys) {
    $idResult = Invoke-NativeCapture docker ($ComposeBaseArguments + @('ps', '--all', '-q', $service))
    if ($idResult.ExitCode -ne 0) {
      throw "Could not inspect Compose service ${service}: $(($idResult.Output | Out-String).Trim())"
    }
    $containerId = Get-UniqueNativeLine $idResult.StdOut '^[0-9a-f]{12,64}$' "Compose service ${service}"

    $imageResult = Invoke-NativeCapture docker @('inspect', '--format', '{{.Image}}', $containerId)
    if ($imageResult.ExitCode -ne 0) {
      throw "Could not inspect image for Compose service ${service}: $(($imageResult.Output | Out-String).Trim())"
    }
    $actual = Get-UniqueNativeLine $imageResult.StdOut '^sha256:[0-9a-f]{64}$' "Container image for ${service}"
    $expectedId = [string]$Expected[$serviceImages[$service]]
    if ($actual -cne $expectedId) {
      throw "Compose service ${service} uses image $actual; expected $expectedId"
    }
  }
}

function Get-ComposeServiceState([string]$Service) {
  $idResult = Invoke-NativeCapture docker ($ComposeBaseArguments + @('ps', '--all', '-q', $Service))
  if ($idResult.ExitCode -ne 0) {
    throw "Could not inspect Compose service ${Service}: $(($idResult.Output | Out-String).Trim())"
  }
  $containerLines = @($idResult.StdOut | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  if ($containerLines.Count -eq 0) { return $null }
  $containerId = Get-UniqueNativeLine $containerLines '^[0-9a-f]{12,64}$' "Compose service ${Service}"

  $stateResult = Invoke-NativeCapture docker @('inspect', '--format', '{{json .State}}', $containerId)
  if ($stateResult.ExitCode -ne 0) {
    throw "Could not inspect container for ${Service}: $(($stateResult.Output | Out-String).Trim())"
  }
  $stateJson = Get-UniqueNativeLine $stateResult.StdOut '^\{.*\}$' "Container state for ${Service}"
  $state = ($stateJson | ConvertFrom-Json)
  $health = if ($state.Health) { [string]$state.Health.Status } else { '' }
  return [pscustomobject]@{
    Status = [string]$state.Status
    ExitCode = [int]$state.ExitCode
    Health = $health
  }
}

function Wait-ReleaseHealth(
  [scriptblock]$GetServiceState,
  [scriptblock]$Delay,
  [int]$TimeoutSeconds = 180
) {
  if (-not $GetServiceState) { $GetServiceState = { param($service) Get-ComposeServiceState $service } }
  if (-not $Delay) { $Delay = { Start-Sleep -Seconds 2 } }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $states = @{}
    foreach ($service in @('postgres', 'redis', 'migrate', 'api', 'web')) {
      $states[$service] = & $GetServiceState $service
      if ($null -eq $states[$service]) { throw "Required Compose service is missing: $service" }
    }

    $migrate = $states.migrate
    if ($migrate.Status -eq 'exited' -and $migrate.ExitCode -ne 0) {
      throw "Migration container exited with exit code $($migrate.ExitCode)."
    }
    $migrateReady = $migrate.Status -eq 'exited' -and $migrate.ExitCode -eq 0

    $servicesReady = $true
    foreach ($service in @('postgres', 'redis', 'api', 'web')) {
      $state = $states[$service]
      if ($state.Status -in @('exited', 'dead') -or $state.Health -eq 'unhealthy') {
        throw "Release service $service failed: status=$($state.Status), health=$($state.Health), exit=$($state.ExitCode)"
      }
      if ($state.Health -ne 'healthy') { $servicesReady = $false }
    }

    if ($migrateReady -and $servicesReady) { return }
    & $Delay
  } while ((Get-Date) -lt $deadline)

  throw 'Timed out waiting for migration completion and service health.'
}

$environmentFile = Join-Path $DeployRoot '.env'
if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
  throw 'deploy/.env is required. Copy deploy/.env.example and set production secrets first.'
}
Assert-ReleaseEnvironment $environmentFile
if (-not (Test-Path -LiteralPath $ImageArchive -PathType Leaf)) {
  throw "Release image archive was not found: $ImageArchive"
}
$expectedImageIds = Read-ExpectedImageIds $ManifestPath $ImageIdContractPath

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker is not installed or is not available on PATH.'
}
Invoke-Native docker @('version')
Invoke-Native docker @('compose', 'version')
$ComposeBaseArguments = @('compose', '--env-file', '.env', '-f', 'docker-compose.yml')

Push-Location $DeployRoot
try {
  Invoke-Native docker ($ComposeBaseArguments + @('config', '--quiet'))
  $serviceResult = Invoke-NativeCapture docker ($ComposeBaseArguments + @('config', '--services'))
  if ($serviceResult.ExitCode -ne 0) { throw 'Could not enumerate release Compose services.' }
  $actualServices = @($serviceResult.StdOut | Where-Object { $_ } | Sort-Object -CaseSensitive)
  $expectedServices = @('api', 'migrate', 'postgres', 'redis', 'web')
  if ([string]::Join("`n", $actualServices) -cne [string]::Join("`n", $expectedServices)) {
    throw 'Release Compose file must contain exactly postgres, redis, migrate, api, and web.'
  }
}
finally { Pop-Location }

Invoke-Native docker @('load', '-i', $ImageArchive)
$loadedImageIds = Assert-LoadedImageIds $expectedImageIds

Push-Location $DeployRoot
$composeAttempted = $false
try {
  $composeAttempted = $true
  Invoke-Native docker ($ComposeBaseArguments + @('up', '-d', '--no-build', '--force-recreate'))
  Assert-ComposeImageIds $loadedImageIds
  Wait-ReleaseHealth
}
catch {
  $originalFailure = $_
  if ($composeAttempted) {
    try { Invoke-Native docker ($ComposeBaseArguments + @('stop')) }
    catch { Write-Warning "Failed to stop the unsuccessful release; inspect it manually: $($_.Exception.Message)" }
  }
  throw $originalFailure
}
finally {
  Pop-Location
}

Write-Host 'Release is healthy: PostgreSQL, Redis, API, and Web are ready at http://localhost:3997'
