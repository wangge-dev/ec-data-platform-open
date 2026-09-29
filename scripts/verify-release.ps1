[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string]$ArchivePath,

  [ValidateNotNullOrEmpty()]
  [string]$WorkingRoot,

  [switch]$PreserveEvidence,

  [switch]$UsePublicTestCredentials
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'sha256.ps1')
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:StrictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
$MaxStartAttempts = 3
$ExpectedFrontProfitColumnCount = 28
$script:FrontProfitFields = [ordered]@{
  Date = $script:StrictUtf8.GetString([Convert]::FromBase64String('5pel5pyf'))
  Amount = 'GMV'
  Quantity = $script:StrictUtf8.GetString([Convert]::FromBase64String('5Y2V6YeP'))
  Shop = $script:StrictUtf8.GetString([Convert]::FromBase64String('5bqX6ZO6'))
  Operator = $script:StrictUtf8.GetString([Convert]::FromBase64String('6L+Q6JCl'))
  ProductCost = $script:StrictUtf8.GetString([Convert]::FromBase64String('5Lqn5ZOB5oiQ5pys'))
  AdSpend = $script:StrictUtf8.GetString([Convert]::FromBase64String('5o6o5bm/6LS5'))
  FrontProfit = $script:StrictUtf8.GetString([Convert]::FromBase64String('5YmN5Y+w5Yip5ram'))
  SupplementalQuantity = $script:StrictUtf8.GetString([Convert]::FromBase64String('6KGl5Y2V5Y2V6YeP'))
  SupplementalAmount = $script:StrictUtf8.GetString([Convert]::FromBase64String('6KGl5Y2V6YeR6aKd'))
  SupplementalProductCost = $script:StrictUtf8.GetString([Convert]::FromBase64String('6KGl5Y2V5Lqn5ZOB5oiQ5pys'))
  ShipmentValue = $script:StrictUtf8.GetString([Convert]::FromBase64String('5Ye66LSn6LSn5YC8'))
  PlatformDeduction = $script:StrictUtf8.GetString([Convert]::FromBase64String('5bmz5Y+w5omj54K5L+avm+S/nQ=='))
  Tax = $script:StrictUtf8.GetString([Convert]::FromBase64String('56iO54K5'))
  FinanceCost = $script:StrictUtf8.GetString([Convert]::FromBase64String('6LSi5Yqh5oiQ5pys'))
  Freight = $script:StrictUtf8.GetString([Convert]::FromBase64String('6L+Q6LS5'))
  Commission = $script:StrictUtf8.GetString([Convert]::FromBase64String('5L2j6YeR'))
  RealRevenue = $script:StrictUtf8.GetString([Convert]::FromBase64String('55yf5a6e6JCl5Lia6aKd'))
  PaidRatio = $script:StrictUtf8.GetString([Convert]::FromBase64String('5LuY6LS55Y2g5q+U'))
  ModuleName = $script:StrictUtf8.GetString([Convert]::FromBase64String('55S15ZWG5YmN5Y+w5Yip5ram'))
}
$FrontProfitCriticalFields = @(
  $script:FrontProfitFields.Date,
  $script:FrontProfitFields.Amount,
  $script:FrontProfitFields.Quantity,
  $script:FrontProfitFields.Shop,
  $script:FrontProfitFields.Operator,
  $script:FrontProfitFields.ProductCost,
  $script:FrontProfitFields.AdSpend,
  $script:FrontProfitFields.FrontProfit
)

function Resolve-SafeWorkingRoot([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw 'WorkingRoot must be explicitly provided; the verifier never uses the system temporary directory.'
  }

  $fullPath = [IO.Path]::GetFullPath($Path)
  $pathRoot = [IO.Path]::GetPathRoot($fullPath)
  $separators = [char[]]@(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  if (
    $fullPath.TrimEnd($separators).Equals(
      $pathRoot.TrimEnd($separators),
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "WorkingRoot cannot be a filesystem root: $fullPath"
  }

  if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
    throw "WorkingRoot must be a directory: $fullPath"
  }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
    New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
  }
  return (Resolve-Path -LiteralPath $fullPath).Path
}

function Expand-SafeReleaseArchive([string]$Path, [string]$DestinationPath) {
  try {
    Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop
  }
  catch {
    throw "Safe release extraction requires the .NET ZIP runtime: $($_.Exception.Message)"
  }
  if ($null -eq ('System.IO.Compression.ZipFile' -as [type])) {
    foreach ($assemblyName in @(
      'System.IO.Compression.FileSystem',
      'System.IO.Compression.ZipFileSystem'
    )) {
      try { Add-Type -AssemblyName $assemblyName -ErrorAction Stop }
      catch { continue }
      if ($null -ne ('System.IO.Compression.ZipFile' -as [type])) { break }
    }
  }
  if ($null -eq ('System.IO.Compression.ZipFile' -as [type])) {
    throw 'Safe release extraction requires System.IO.Compression.ZipFile, but it is unavailable.'
  }
  if (-not (Test-Path -LiteralPath $DestinationPath -PathType Container)) {
    throw "Safe release extraction destination was not found: $DestinationPath"
  }

  $destinationRoot = [IO.Path]::GetFullPath($DestinationPath)
  $separators = [char[]]@(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $destinationPrefix = $destinationRoot.TrimEnd($separators) + [IO.Path]::DirectorySeparatorChar
  $pathComparison = if ([IO.Path]::DirectorySeparatorChar -eq '\') {
    [StringComparison]::OrdinalIgnoreCase
  }
  else {
    [StringComparison]::Ordinal
  }
  # Reject case-only duplicates on every OS so an archive accepted on Linux is also safe on Windows.
  $seenPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $filePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $requiredDirectoryPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $topLevelNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $records = [Collections.Generic.List[object]]::new()
  $maxEntryCount = 4096
  $maxArchiveBytes = [int64]4GB
  $maxEntryBytes = [int64]2GB
  $maxTotalBytes = [int64]4GB
  $maxCompressionRatio = 200.0
  $compressionRatioMinimumBytes = [int64]1MB

  $archiveInfo = Get-Item -LiteralPath $Path -Force
  if ([int64]$archiveInfo.Length -gt $maxArchiveBytes) {
    throw "Release archive exceeds the $maxArchiveBytes-byte compressed-file limit."
  }

  try {
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
  }
  catch {
    throw "Release archive could not be opened by the safe ZIP extractor: $($_.Exception.Message)"
  }
  try {
    # Validate every entry before writing any bytes. This prevents a later malicious entry
    # from leaving a partially extracted payload behind.
    if ($archive.Entries.Count -gt $maxEntryCount) {
      throw "Release archive contains too many entries (maximum $maxEntryCount)."
    }
    $declaredTotalBytes = [int64]0
    foreach ($entry in $archive.Entries) {
      $relative = [string]$entry.FullName
      # .NET Framework creates ZIP entries with backslashes on Windows; treat both
      # separators identically before applying the portable path policy.
      $normalizedRelative = $relative.Replace('\', '/')
      $isDirectory = $normalizedRelative.EndsWith('/', [StringComparison]::Ordinal)
      $canonical = if ($isDirectory) {
        $normalizedRelative.Substring(0, $normalizedRelative.Length - 1)
      }
      else {
        $normalizedRelative
      }
      $parts = @($canonical.Split('/'))
      if ([string]::IsNullOrWhiteSpace($canonical) -or
          $normalizedRelative -match '[\x00-\x1f\x7f]' -or
          $normalizedRelative.StartsWith('/', [StringComparison]::Ordinal) -or
          $normalizedRelative -match '^[A-Za-z]:' -or
          @($parts | Where-Object { -not $_ -or $_ -in @('.', '..') }).Count -gt 0 -or
          -not $seenPaths.Add($canonical)) {
        throw "Release archive contains an unsafe or duplicate entry path: $relative"
      }
      foreach ($part in $parts) {
        $deviceBaseName = ([string]$part.Split('.')[0]).TrimEnd(' ', '.')
        if ($part -match '[<>:"|?*]' -or $part.EndsWith('.', [StringComparison]::Ordinal) -or
            $part.EndsWith(' ', [StringComparison]::Ordinal) -or
            $deviceBaseName -match '^(?i:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9\u00B9\u00B2\u00B3]|LPT[1-9\u00B9\u00B2\u00B3])$') {
          throw "Release archive contains a Windows-incompatible entry path: $relative"
        }
      }
      $topLevelNames.Add($parts[0]) | Out-Null
      if ($parts.Count -eq 1 -and -not $isDirectory) {
        throw 'Release archive must contain exactly one top-level directory.'
      }

      $ancestorParts = [Collections.Generic.List[string]]::new()
      for ($partIndex = 0; $partIndex -lt ($parts.Count - 1); $partIndex++) {
        $ancestorParts.Add($parts[$partIndex])
        $ancestor = [string]::Join('/', $ancestorParts)
        if ($filePaths.Contains($ancestor)) {
          throw "Release archive contains a file/directory prefix conflict: $relative"
        }
        $requiredDirectoryPaths.Add($ancestor) | Out-Null
      }
      if (-not $isDirectory) {
        if ($requiredDirectoryPaths.Contains($canonical)) {
          throw "Release archive contains a file/directory prefix conflict: $relative"
        }
        $filePaths.Add($canonical) | Out-Null
      }

      $externalAttributes = [int64]$entry.ExternalAttributes
      $unixFileType = ($externalAttributes -shr 16) -band 0xF000
      $dosAttributes = $externalAttributes -band 0xFFFF
      if ($unixFileType -eq 0xA000 -or
          ($dosAttributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Release archive contains a symbolic-link or reparse-point entry: $relative"
      }
      if ($unixFileType -notin @(0x0000, 0x4000, 0x8000)) {
        throw "Release archive contains an unsupported Unix special-file entry: $relative"
      }
      if (($unixFileType -eq 0x4000 -and -not $isDirectory) -or
          ($unixFileType -eq 0x8000 -and $isDirectory)) {
        throw "Release archive entry type disagrees with its path: $relative"
      }
      if ($isDirectory -and [int64]$entry.Length -ne 0) {
        throw "Release archive contains a non-empty directory entry: $relative"
      }
      $entryBytes = [int64]$entry.Length
      $compressedBytes = [int64]$entry.CompressedLength
      if ($entryBytes -gt $maxEntryBytes) {
        throw "Release archive entry exceeds the $maxEntryBytes-byte extraction limit: $relative"
      }
      if (-not $isDirectory -and $entryBytes -ge $compressionRatioMinimumBytes -and
          ($compressedBytes -le 0 -or ($entryBytes / [double]$compressedBytes) -gt $maxCompressionRatio)) {
        throw "Release archive entry exceeds the $maxCompressionRatio-to-1 compression-ratio limit: $relative"
      }
      $declaredTotalBytes += $entryBytes
      if ($declaredTotalBytes -gt $maxTotalBytes) {
        throw "Release archive exceeds the $maxTotalBytes-byte total extraction limit."
      }

      $targetPath = $destinationRoot
      foreach ($part in $parts) { $targetPath = Join-Path $targetPath $part }
      $targetPath = [IO.Path]::GetFullPath($targetPath)
      if (-not $targetPath.StartsWith($destinationPrefix, $pathComparison)) {
        throw "Release archive entry escaped its extraction root: $relative"
      }
      $records.Add([pscustomobject]@{
        Entry = $entry
        IsDirectory = $isDirectory
        TargetPath = $targetPath
        ExpectedLength = $entryBytes
      }) | Out-Null
    }
    if ($topLevelNames.Count -ne 1) {
      throw 'Release archive must contain exactly one top-level directory.'
    }

    $actualTotalBytes = [int64]0
    $copyBuffer = New-Object 'Byte[]' (1MB)
    foreach ($record in $records) {
      if ($record.IsDirectory) {
        [IO.Directory]::CreateDirectory([string]$record.TargetPath) | Out-Null
        continue
      }
      $parentPath = [IO.Path]::GetDirectoryName([string]$record.TargetPath)
      [IO.Directory]::CreateDirectory($parentPath) | Out-Null
      $sourceStream = $record.Entry.Open()
      try {
        $targetStream = [IO.File]::Open(
          [string]$record.TargetPath,
          [IO.FileMode]::CreateNew,
          [IO.FileAccess]::Write,
          [IO.FileShare]::None
        )
        try {
          $actualEntryBytes = [int64]0
          while (($read = $sourceStream.Read($copyBuffer, 0, $copyBuffer.Length)) -gt 0) {
            $actualEntryBytes += $read
            $actualTotalBytes += $read
            if ($actualEntryBytes -gt [int64]$record.ExpectedLength -or
                $actualEntryBytes -gt $maxEntryBytes -or $actualTotalBytes -gt $maxTotalBytes) {
              throw "Release archive produced more data than declared or allowed: $([string]$record.Entry.FullName)"
            }
            $targetStream.Write($copyBuffer, 0, $read)
          }
          if ($actualEntryBytes -ne [int64]$record.ExpectedLength) {
            throw "Release archive entry length did not match its ZIP metadata: $([string]$record.Entry.FullName)"
          }
        }
        finally { $targetStream.Dispose() }
      }
      finally { $sourceStream.Dispose() }
    }
  }
  finally {
    $archive.Dispose()
  }
}

function Invoke-Native([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}

function Invoke-CurrentPowerShellScript([string]$Path, [string[]]$Arguments) {
  $hostExecutable = (Get-Process -Id $PID).Path
  if (-not (Test-Path -LiteralPath $hostExecutable -PathType Leaf)) {
    throw 'Could not resolve the current PowerShell executable.'
  }
  $hostArguments = @('-NoProfile')
  if ($env:OS -eq 'Windows_NT') {
    $hostArguments += @('-ExecutionPolicy', 'Bypass')
  }
  $hostArguments += @('-File', $Path)
  $hostArguments += $Arguments
  Invoke-Native $hostExecutable $hostArguments
}

function Invoke-NativeCapture([string]$File, [string[]]$Arguments) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $File @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = $output
  }
}

function New-CryptoSecret([int]$ByteCount = 32) {
  $bytes = New-Object 'Byte[]' $ByteCount
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  }
  finally {
    $generator.Dispose()
  }
  return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-FreeTcpPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, 0)
  $listener.Start()
  try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

function New-Isolation {
  $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 12)
  $allocatedPorts = [Collections.Generic.HashSet[int]]::new()
  $ports = [ordered]@{}
  foreach ($name in @('POSTGRES_HOST_PORT', 'REDIS_HOST_PORT', 'API_HOST_PORT', 'WEB_HOST_PORT')) {
    do { $port = Get-FreeTcpPort } until ($allocatedPorts.Add($port))
    $ports[$name] = $port
  }
  return [pscustomobject]@{
    Project = "ecdatarelease$suffix"
    Ports = $ports
  }
}

function Wait-Http([string]$Uri, [int]$Seconds = 120) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    try { return Invoke-RestMethod -Uri $Uri -TimeoutSec 5 }
    catch { Start-Sleep -Seconds 2 }
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for $Uri"
}

function Wait-WebHttp200([string]$Uri, [int]$Seconds = 120) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 5
      if ($response.StatusCode -eq 200) { return $response }
    }
    catch { Start-Sleep -Seconds 2 }
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for HTTP 200 from $Uri"
}

function Invoke-Compose([string]$project, [string[]]$Arguments) {
  & docker compose --env-file .env -f docker-compose.yml -p $project @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker compose failed with exit code $LASTEXITCODE" }
}

function Invoke-IsolatedDown([string]$Project, [string]$DeployRoot) {
  if ($PreserveEvidence) {
    throw 'Invoke-IsolatedDown is disabled while PreserveEvidence is active.'
  }
  Push-Location -LiteralPath $DeployRoot
  try {
    Invoke-Compose -Project $Project -Arguments @('down', '-v', '--remove-orphans')
  }
  finally {
    Pop-Location
  }
}

function Test-PortAllocationFailure([string]$Message) {
  return $Message -match '(?i)(port is already allocated|ports are not available|failed to bind (host )?port|bind:.*address already in use|only one usage of each socket address)'
}

function Start-IsolatedCompose([string]$project, [scriptblock]$Capture) {
  $arguments = @(
    'compose', '--env-file', '.env', '-f', 'docker-compose.yml',
    '-p', $project, 'up', '-d', '--no-build'
  )
  $result = if ($Capture) {
    & $Capture 'docker' $arguments
  }
  else {
    Invoke-NativeCapture -File docker -Arguments $arguments
  }
  $exitCode = [int]$result.ExitCode
  if ($exitCode -eq 0) { return $true }

  $message = ($result.Output | Out-String).Trim()
  if (-not (Test-PortAllocationFailure $message)) {
    throw "docker compose up failed with exit code ${exitCode}: $message"
  }
  Write-Warning "Compose port allocation failed for project $project; allocating a new isolated attempt."
  return $false
}

function Assert-IsolatedComposeContract([string]$Project) {
  Invoke-Compose -Project $Project -Arguments @('config', '--quiet')
  $arguments = @(
    'compose', '--env-file', '.env', '-f', 'docker-compose.yml',
    '-p', $Project, 'config', '--services'
  )
  $result = Invoke-NativeCapture -File docker -Arguments $arguments
  if ([int]$result.ExitCode -ne 0) {
    throw 'Could not enumerate release Compose services.'
  }
  $actualServices = @(
    $result.Output | ForEach-Object { [string]$_ } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      Sort-Object -CaseSensitive
  )
  $expectedServices = @('api', 'migrate', 'postgres', 'redis', 'web')
  if ([string]::Join("`n", $actualServices) -cne [string]::Join("`n", $expectedServices)) {
    throw 'Release Compose file must contain exactly postgres, redis, migrate, api, and web.'
  }
}

function Get-DockerImageId([string]$Image, [scriptblock]$Capture) {
  $arguments = @('image', 'inspect', '--format', '{{.Id}}', $Image)
  $result = if ($Capture) {
    & $Capture 'docker' $arguments
  }
  else {
    Invoke-NativeCapture -File docker -Arguments $arguments
  }
  $exitCode = [int]$result.ExitCode
  $message = ($result.Output | Out-String).Trim()
  if ($exitCode -eq 0) { return $message }
  if ($message -match '(?i)no such image') { return $null }
  throw "docker image inspect failed for ${Image}: $message"
}

function Assert-LoadedReleaseImageIds([pscustomobject]$Manifest, [string]$ImageArchivePath) {
  foreach ($image in @($Manifest.images)) {
    $expectedId = [string]$Manifest.imageIds.PSObject.Properties[[string]$image].Value
    $actualId = [string](Get-DockerImageId -Image ([string]$image))
    $archiveMatch = $false
    if ($actualId -cmatch '^sha256:[0-9a-f]{64}$' -and $actualId -cne $expectedId -and
        $ImageArchivePath -and (Get-Command tar -ErrorAction SilentlyContinue)) {
      # Assert-ReleasePayloadManifest already authenticated this archive's bytes.
      $member = 'blobs/sha256/' + $actualId.Substring(7)
      $result = Invoke-NativeCapture -File tar -Arguments @('-xOf', $ImageArchivePath, $member)
      if ($result.ExitCode -eq 0) {
        try {
          $archived = ($result.Output -join "`n") | ConvertFrom-Json
          $archiveMatch = $archived.schemaVersion -eq 2 -and
            $archived.mediaType -cin @('application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json') -and
            [string]$archived.config.digest -ceq $expectedId
        } catch { $archiveMatch = $false }
      }
    }
    if ($actualId -cnotmatch '^sha256:[0-9a-f]{64}$' -or ($actualId -cne $expectedId -and -not $archiveMatch)) {
      throw "Loaded image ID mismatch for ${image}: expected $expectedId, found $actualId"
    }
  }
}

function Save-ImageTagState([string[]]$Images) {
  $snapshot = [ordered]@{}
  foreach ($image in $Images) {
    $snapshot[$image] = Get-DockerImageId -Image $image
  }
  return $snapshot
}

function Restore-ImageTags([System.Collections.IDictionary]$Snapshot, [string[]]$Images) {
  if ($PreserveEvidence) {
    throw 'Restore-ImageTags is disabled while PreserveEvidence is active.'
  }
  $failures = [Collections.Generic.List[string]]::new()
  foreach ($image in $Images) {
    try {
      if (-not $Snapshot.Contains($image)) { continue }
      $beforeId = [string]$Snapshot[$image]
      $currentId = [string](Get-DockerImageId -Image $image)

      if (-not [string]::IsNullOrWhiteSpace($beforeId)) {
        if ($currentId -ne $beforeId) {
          Invoke-Native docker @('image', 'tag', $beforeId, $image)
        }
      }
      elseif (-not [string]::IsNullOrWhiteSpace($currentId)) {
        Invoke-Native docker @('image', 'rm', $image)
      }

      $restoredId = [string](Get-DockerImageId -Image $image)
      if ($restoredId -ne $beforeId) {
        throw "Expected '$beforeId' after restoration, found '$restoredId'."
      }
    }
    catch {
      $failures.Add("${image}: $($_.Exception.Message)") | Out-Null
    }
  }
  if ($failures.Count -gt 0) {
    throw "Image tag restoration failed: $($failures -join '; ')"
  }
}

function Write-AcceptanceEnvironment(
  [string]$DeployRoot,
  [string]$project,
  [System.Collections.IDictionary]$ports,
  [string]$PostgresPassword,
  [string]$AppDbPassword,
  [string]$JwtSecret,
  [string]$AdminPassword
) {
  $envText = @"
INSTANCE_ID=$project
POSTGRES_PASSWORD=$PostgresPassword
APP_DB_PASSWORD=$AppDbPassword
JWT_SECRET=$JwtSecret
ADMIN_PASSWORD=$AdminPassword
DEEPSEEK_API_KEY=
CORS_ORIGIN=http://localhost:$($ports.WEB_HOST_PORT)
COMPOSE_PROJECT_NAME=$project
POSTGRES_HOST_PORT=127.0.0.1:$($ports.POSTGRES_HOST_PORT)
REDIS_HOST_PORT=127.0.0.1:$($ports.REDIS_HOST_PORT)
API_HOST_PORT=127.0.0.1:$($ports.API_HOST_PORT)
WEB_HOST_PORT=127.0.0.1:$($ports.WEB_HOST_PORT)
POSTGRES_CONTAINER_NAME=${project}-postgres
REDIS_CONTAINER_NAME=${project}-redis
MIGRATE_CONTAINER_NAME=${project}-migrate
API_CONTAINER_NAME=${project}-api
WEB_CONTAINER_NAME=${project}-web
"@
  [IO.File]::WriteAllText((Join-Path $DeployRoot '.env'), $envText, $script:Utf8NoBom)
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

function Assert-ReleasePayloadManifest([string]$ReleaseRoot) {
  $manifestPath = Join-Path $ReleaseRoot 'release-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Release manifest was not found.' }
  $manifestJson = [IO.File]::ReadAllText($manifestPath, $script:StrictUtf8)
  $manifest = $manifestJson | ConvertFrom-Json
  $expectedRootProperties = @('name', 'createdAt', 'sourceRevision', 'imageSource', 'images', 'imageIds', 'files')
  if ($manifest -isnot [pscustomobject] -or
      [string]::Join("`n", @($manifest.PSObject.Properties | ForEach-Object { $_.Name })) -cne
      [string]::Join("`n", $expectedRootProperties) -or $manifest.files -isnot [System.Array]) {
    throw 'Release manifest does not use the canonical schema.'
  }
  if (-not (Test-CanonicalUtcJsonTimestamp -Json $manifestJson -PropertyName 'createdAt')) {
    throw 'Release manifest createdAt must be a canonical timestamp.'
  }
  if ([string]$manifest.name -cne [IO.Path]::GetFileName($ReleaseRoot) -or
      [string]$manifest.sourceRevision -cnotmatch '^[0-9a-f]{40}$' -or
      [string]$manifest.imageSource -cnotmatch '^(local-build|prebuilt-archive)$') {
    throw 'Release manifest identity or image source is invalid.'
  }
  $requiredImages = @('postgres:16', 'redis:7-alpine', 'deploy-api:latest', 'deploy-web:latest')
  if ($manifest.images -isnot [System.Array] -or
      [string]::Join("`n", @($manifest.images | ForEach-Object { [string]$_ })) -cne [string]::Join("`n", $requiredImages) -or
      $manifest.imageIds -isnot [pscustomobject]) {
    throw 'Release manifest images or imageIds is invalid.'
  }
  $imageIdProperties = @($manifest.imageIds.PSObject.Properties)
  if ([string]::Join("`n", @($imageIdProperties | ForEach-Object { $_.Name })) -cne [string]::Join("`n", $requiredImages)) {
    throw 'Release manifest imageIds must use canonical image order.'
  }
  $contractLines = @()
  foreach ($image in $requiredImages) {
    $imageId = [string]$manifest.imageIds.PSObject.Properties[$image].Value
    if ($imageId -cnotmatch '^sha256:[0-9a-f]{64}$') { throw "Release manifest has an invalid image ID for $image." }
    $contractLines += "$image=$imageId"
  }
  $contractPath = Join-Path $ReleaseRoot 'release-image-ids.txt'
  $expectedContract = [string]::Join("`n", $contractLines) + "`n"
  if (-not (Test-Path -LiteralPath $contractPath -PathType Leaf) -or
      [IO.File]::ReadAllText($contractPath, $script:StrictUtf8) -cne $expectedContract) {
    throw 'Release image-ID contract does not match the manifest.'
  }
  $listed = @($manifest.files)
  $listedPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($entry in $listed) {
    $properties = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
    $relative = [string]$entry.path
    $parts = @($relative.Split('/'))
    if ($entry -isnot [pscustomobject] -or [string]::Join("`n", $properties) -cne "path`nsize`nsha256" -or
        -not $relative -or $relative -match '[\x00-\x1f\x7f\\]' -or $relative.StartsWith('/') -or
        $relative -match '^[A-Za-z]:' -or @($parts | Where-Object { -not $_ -or $_ -in @('.', '..') }).Count -gt 0 -or
        -not $listedPaths.Add($relative) -or [string]$entry.size -cnotmatch '^(0|[1-9][0-9]*)$' -or
        [string]$entry.sha256 -cnotmatch '^[0-9a-f]{64}$') {
      throw 'Release manifest contains invalid file metadata.'
    }
  }

  $rootPrefix = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\') + '\'
  if (([IO.File]::GetAttributes($ReleaseRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Extracted release root must not be a reparse point.'
  }
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($ReleaseRoot)
  $actual = [Collections.Generic.List[object]]::new()
  while ($pending.Count -gt 0) {
    foreach ($path in [IO.Directory]::EnumerateFileSystemEntries($pending.Pop())) {
      $attributes = [IO.File]::GetAttributes($path)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Extracted release payload contains a reparse point.' }
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { $pending.Push($path); continue }
      $fullName = [IO.Path]::GetFullPath($path)
      $relative = $fullName.Substring($rootPrefix.Length).Replace('\', '/')
      if ($relative -ceq 'release-manifest.json' -or $relative -ceq 'deploy/.env') { continue }
      $fileInfo = [IO.FileInfo]::new($fullName)
      if (-not $fileInfo.Exists) { throw "Release payload file disappeared during verification: $relative" }
      $actual.Add([pscustomobject]@{
        path = $relative
        size = [int64]$fileInfo.Length
        sha256 = Get-Sha256Hex $fullName
      }) | Out-Null
    }
  }
  $listed = @($listed | Sort-Object { [string]$_.path })
  $actual = @($actual | Sort-Object { [string]$_.path })
  if ($listed.Count -ne $actual.Count) { throw 'Release manifest files do not match the extracted payload.' }
  for ($index = 0; $index -lt $actual.Count; $index++) {
    if ([string]$listed[$index].path -cne [string]$actual[$index].path -or
        [int64]$listed[$index].size -ne [int64]$actual[$index].size -or
        [string]$listed[$index].sha256 -cne [string]$actual[$index].sha256) {
      throw "Release manifest file integrity check failed: $([string]$actual[$index].path)"
    }
  }
  if ([string]$manifest.imageSource -ceq 'prebuilt-archive') {
    $provenancePath = Join-Path $ReleaseRoot 'image-provenance.json'
    $imageArchivePath = Join-Path $ReleaseRoot 'ec-data-images.tar'
    if (-not (Test-Path -LiteralPath $provenancePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $imageArchivePath -PathType Leaf)) {
      throw 'Prebuilt release is missing its image provenance or archive.'
    }
    $provenance = [IO.File]::ReadAllText($provenancePath, $script:StrictUtf8) | ConvertFrom-Json
    $expectedProvenanceRoot = "schemaVersion`nsourceRevision`narchiveSha256`nimages"
    if ($provenance -isnot [pscustomobject] -or
        [string]::Join("`n", @($provenance.PSObject.Properties | ForEach-Object { $_.Name })) -cne
        $expectedProvenanceRoot -or [int]$provenance.schemaVersion -ne 1 -or
        [string]$provenance.sourceRevision -cne [string]$manifest.sourceRevision -or
        [string]$provenance.archiveSha256 -cne
        (Get-Sha256Hex $imageArchivePath) -or
        $provenance.images -isnot [pscustomobject]) {
      throw 'Prebuilt image provenance does not match the release archive.'
    }
    $provenanceImages = @($provenance.images.PSObject.Properties)
    if ([string]::Join("`n", @($provenanceImages | ForEach-Object { $_.Name })) -cne
        [string]::Join("`n", $requiredImages)) {
      throw 'Prebuilt image provenance must use canonical image order.'
    }
    foreach ($image in $requiredImages) {
      $entry = $provenance.images.PSObject.Properties[$image].Value
      $properties = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
      $repository = [string]$entry.registryRepository
      $digest = [string]$entry.digest
      if ($entry -isnot [pscustomobject] -or
          [string]::Join("`n", $properties) -cne "imageId`nregistryRepository`ndigest`nreference" -or
          [string]$entry.imageId -cne [string]$manifest.imageIds.PSObject.Properties[$image].Value -or
          $repository -cnotmatch '^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+$' -or
          $digest -cnotmatch '^sha256:[0-9a-f]{64}$' -or
          [string]$entry.reference -cne ($repository + '@' + $digest)) {
        throw "Prebuilt image provenance is invalid for $image."
      }
    }
  }
  return $manifest
}

function Save-ProcessEnvironment([string[]]$Names) {
  $snapshot = [ordered]@{}
  foreach ($name in $Names) {
    $snapshot[$name] = [Environment]::GetEnvironmentVariable(
      $name,
      [EnvironmentVariableTarget]::Process
    )
  }
  return $snapshot
}

function Set-AcceptanceProcessEnvironment(
  [string]$project,
  [System.Collections.IDictionary]$ports,
  [string]$PostgresPassword,
  [string]$AppDbPassword,
  [string]$JwtSecret,
  [string]$AdminPassword
) {
  $values = [ordered]@{
    INSTANCE_ID = $project
    POSTGRES_PASSWORD = $PostgresPassword
    APP_DB_PASSWORD = $AppDbPassword
    JWT_SECRET = $JwtSecret
    ADMIN_PASSWORD = $AdminPassword
    DEEPSEEK_API_KEY = ''
    CORS_ORIGIN = "http://localhost:$($ports.WEB_HOST_PORT)"
    COMPOSE_PROJECT_NAME = $project
    POSTGRES_HOST_PORT = "127.0.0.1:$($ports.POSTGRES_HOST_PORT)"
    REDIS_HOST_PORT = "127.0.0.1:$($ports.REDIS_HOST_PORT)"
    API_HOST_PORT = "127.0.0.1:$($ports.API_HOST_PORT)"
    WEB_HOST_PORT = "127.0.0.1:$($ports.WEB_HOST_PORT)"
    POSTGRES_CONTAINER_NAME = "${project}-postgres"
    REDIS_CONTAINER_NAME = "${project}-redis"
    MIGRATE_CONTAINER_NAME = "${project}-migrate"
    API_CONTAINER_NAME = "${project}-api"
    WEB_CONTAINER_NAME = "${project}-web"
  }
  foreach ($entry in $values.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable(
      [string]$entry.Key,
      [string]$entry.Value,
      [EnvironmentVariableTarget]::Process
    )
  }
}

function Invoke-Utf8JsonApi(
  [string]$Uri,
  [string]$Method = 'GET',
  [string]$Token,
  [object]$Body = $null
) {
  Add-Type -AssemblyName System.Net.Http
  $client = [Net.Http.HttpClient]::new()
  $request = [Net.Http.HttpRequestMessage]::new(
    [Net.Http.HttpMethod]::new($Method.ToUpperInvariant()),
    $Uri
  )
  $content = $null
  $response = $null
  try {
    $client.Timeout = [TimeSpan]::FromSeconds(120)
    if (-not [string]::IsNullOrWhiteSpace($Token)) {
      $request.Headers.Authorization =
        [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Token)
    }
    if ($null -ne $Body) {
      $json = $Body | ConvertTo-Json -Depth 15 -Compress
      $content = [Net.Http.ByteArrayContent]::new($script:StrictUtf8.GetBytes($json))
      $content.Headers.ContentType =
        [Net.Http.Headers.MediaTypeHeaderValue]::new('application/json')
      $content.Headers.ContentType.CharSet = 'utf-8'
      $request.Content = $content
    }

    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    $text = $script:StrictUtf8.GetString($bytes)
    if (-not $response.IsSuccessStatusCode) {
      throw "API request failed with HTTP $([int]$response.StatusCode)."
    }
    try {
      return $text | ConvertFrom-Json
    }
    catch {
      throw 'API request returned invalid UTF-8 JSON.'
    }
  }
  finally {
    if ($response) { $response.Dispose() }
    if ($content) { $content.Dispose() }
    $request.Dispose()
    $client.Dispose()
  }
}

function Restore-ProcessEnvironment([System.Collections.IDictionary]$Snapshot) {
  foreach ($entry in $Snapshot.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable(
      [string]$entry.Key,
      $entry.Value,
      [EnvironmentVariableTarget]::Process
    )
  }
}

function Invoke-InstanceOperatorScript(
  [string]$Path,
  [string[]]$Arguments,
  [scriptblock]$Invoker = {
    param($ScriptPath, $ScriptArguments)
    Invoke-CurrentPowerShellScript -Path $ScriptPath -Arguments $ScriptArguments
  }
) {
  $overrideNames = @(Get-ChildItem Env: | Where-Object {
    $_.Name -like 'COMPOSE_*' -or $_.Name -like 'DOCKER_*'
  } | ForEach-Object { $_.Name })
  $snapshot = Save-ProcessEnvironment -Names $overrideNames
  try {
    foreach ($name in $overrideNames) {
      Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction Stop
    }
    & $Invoker $Path $Arguments
  }
  finally {
    Restore-ProcessEnvironment -Snapshot $snapshot
  }
}

function Get-FrontProfitTemplateBundle([string]$ReleaseRoot) {
  $templateRoot = Join-Path $ReleaseRoot 'templates/front-profit'
  if (-not (Test-Path -LiteralPath $templateRoot -PathType Container)) {
    throw "Front-profit template directory was not found: $templateRoot"
  }

  $manifestPath = Join-Path $templateRoot 'template-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Front-profit template manifest was not found: $manifestPath"
  }
  try {
    $manifest = [IO.File]::ReadAllText(
      $manifestPath,
      [Text.Encoding]::UTF8
    ) | ConvertFrom-Json
  }
  catch {
    throw "Front-profit template manifest is not valid UTF-8 JSON: $($_.Exception.Message)"
  }

  if ($manifest.containsRealBusinessData -ne $false) {
    throw 'Front-profit template manifest must declare containsRealBusinessData=false.'
  }
  $entries = @($manifest.files)
  if ($entries.Count -eq 0) {
    throw 'Front-profit template manifest contains no files.'
  }

  $seen = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  foreach ($entry in $entries) {
    $name = [string]$entry.name
    $expectedHash = ([string]$entry.sha256).ToUpperInvariant()
    if (
      [string]::IsNullOrWhiteSpace($name) -or
      $name -match '[/\\]' -or
      [IO.Path]::GetFileName($name) -ne $name
    ) {
      throw "Front-profit template manifest contains an unsafe file name: $name"
    }
    if (-not $seen.Add($name)) {
      throw "Front-profit template manifest contains a duplicate file name: $name"
    }
    if ($expectedHash -notmatch '^[A-F0-9]{64}$') {
      throw "Front-profit template manifest contains an invalid SHA-256 for: $name"
    }

    $filePath = Join-Path $templateRoot $name
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
      throw "Front-profit template file listed by the manifest was not found: $name"
    }
    $actualHash = (Get-Sha256Hex $filePath).ToUpperInvariant()
    if ($actualHash -ne $expectedHash) {
      throw "Front-profit template SHA-256 mismatch: $name"
    }
  }

  $manifestXlsx = @(
    $entries |
      Where-Object { ([string]$_.name).EndsWith('.xlsx', [StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object { [string]$_.name } |
      Sort-Object
  )
  $packagedXlsx = @(
    Get-ChildItem -LiteralPath $templateRoot -File -Filter '*.xlsx' |
      ForEach-Object { $_.Name } |
      Sort-Object
  )
  if (($manifestXlsx -join "`n") -ne ($packagedXlsx -join "`n")) {
    throw 'Front-profit template XLSX files do not exactly match template-manifest.json.'
  }

  $uploadEntries = @(
    $entries |
      Where-Object {
        $_.purpose -eq 'self-service-single-table-upload' -and
        ([string]$_.name).StartsWith('01-', [StringComparison]::Ordinal) -and
        ([string]$_.name).EndsWith('.xlsx', [StringComparison]::OrdinalIgnoreCase)
      }
  )
  if ($uploadEntries.Count -ne 1) {
    throw 'Front-profit template manifest must identify exactly one 01 self-service upload workbook.'
  }

  return [pscustomobject]@{
    Root = $templateRoot
    ManifestPath = $manifestPath
    Manifest = $manifest
    UploadPath = Join-Path $templateRoot ([string]$uploadEntries[0].name)
  }
}

function New-FrontProfitAcceptanceCsv([string]$Directory) {
  # Fully synthetic, formula-consistent row. The packaged XLSX remains untouched;
  # the standard upload gate intentionally rejects its instructional sample row.
  $csvBase64 = '5pel5pyfLOW5s+WPsCzkuJrliqHmqKHlvI8s57uELOW6l+mTuizlupfpk7oyLOi/kOiQpSzljZXph48sR01WLOihpeWNlemHkeminSzooaXljZXkuqflk4HmiJDmnKws6KGl5Y2V5Y2V6YePLOS6p+WTgeaIkOacrCzlh7rotKfotKflgLws5bmz5Y+w5omj54K5L+avm+S/nSznqI7ngrks6LSi5Yqh5oiQ5pysLOi/kOi0uSzkvaPph5Es5o6o5bm/6LS5LOadpea6kOaWh+S7tizmnaXmupDmibnmrKEs5aSH5rOoLOecn+WunuiQpeS4muminSzliY3lj7DliKnmtqYs5LuY6LS55Y2g5q+ULHJlY29yZF9pZCzmlbDmja7nirbmgIEKMjA5OS0xMi0zMSzlkIjmiJDlubPlj7As5YW25LuWLOWQiOaIkOe7hCzlkIjmiJDlupfpk7os5ZCI5oiQ5bqX6ZO6LOWQiOaIkOi/kOiQpSwxLDEwMCwwLDAsMCwyMCwxMDAsNSwxLDEsMiwzLDEwLHJlbGVhc2UtYWNjZXB0YW5jZS5jc3YsUkVMRUFTRS1TWU5USEVUSUMs5LuF55So5LqO6ZqU56a75Y+R5biD6aqM5pS2LDEwMCw1OCwwLjEsUkVMRUFTRV9TWU5USEVUSUNfMjA5OTEyMzEs5ZCI5oiQ6aqM5pS2Cg=='
  $path = Join-Path $Directory 'front-profit-standard-release-acceptance.csv'
  [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($csvBase64))
  return $path
}

function Invoke-FrontProfitTemplateUpload(
  [string]$Uri,
  [string]$Token,
  [string]$TemplatePath
) {
  # Windows PowerShell 5.1 HttpClient emits multipart bodies that Node's
  # Fetch/FormData parser can reject. Native curl is present on supported
  # Windows and Linux hosts and matches the browser-compatible wire format.
  $curlCommand = Get-Command 'curl.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $curlCommand) {
    $curlCommand = Get-Command 'curl' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  if (-not $curlCommand) {
    throw 'Native curl is required for front-profit template verification.'
  }

  $responsePath = Join-Path `
    (Split-Path -Parent $TemplatePath) `
    'front-profit-upload-response.json'
  $capture = Invoke-NativeCapture -File $curlCommand.Source -Arguments @(
    '--silent',
    '--show-error',
    '--max-time', '120',
    '--request', 'POST',
    '--header', "Authorization: Bearer $Token",
    '--form', "file=@$TemplatePath;filename=front-profit-standard-release-acceptance.csv;type=text/csv",
    '--form-string', 'name=front-profit-template-smoke',
    '--form-string', 'role=file',
    '--output', $responsePath,
    '--write-out', '%{http_code}',
    $Uri
  )
  if ($capture.ExitCode -ne 0) {
    throw "Front-profit template upload transport failed with curl exit $($capture.ExitCode)."
  }

  $statusOutput = ((@($capture.Output) | ForEach-Object { [string]$_ }) -join '').Trim()
  if ($statusOutput -notmatch '^[0-9]{3}$') {
    throw 'Front-profit template upload did not return an HTTP status.'
  }

  $statusCode = [int]$statusOutput
  if ($statusCode -lt 200 -or $statusCode -ge 300) {
    throw "Front-profit template upload failed with HTTP $statusCode."
  }
  if (-not (Test-Path -LiteralPath $responsePath -PathType Leaf)) {
    throw 'Front-profit template upload did not write a response body.'
  }
  $body = [IO.File]::ReadAllText($responsePath, $script:StrictUtf8)
  try {
    return $body | ConvertFrom-Json
  }
  catch {
    throw 'Front-profit template upload returned invalid JSON.'
  }
}

function Get-FrontProfitColumnType([string]$Header) {
  if ($Header -eq $script:FrontProfitFields.Date) { return 'date' }
  if ($Header -in @(
    $script:FrontProfitFields.Quantity,
    $script:FrontProfitFields.SupplementalQuantity
  )) { return 'int' }
  if ($Header -in @(
    $script:FrontProfitFields.Amount,
    $script:FrontProfitFields.SupplementalAmount,
    $script:FrontProfitFields.SupplementalProductCost,
    $script:FrontProfitFields.ProductCost,
    $script:FrontProfitFields.ShipmentValue,
    $script:FrontProfitFields.PlatformDeduction,
    $script:FrontProfitFields.Tax,
    $script:FrontProfitFields.FinanceCost,
    $script:FrontProfitFields.Freight,
    $script:FrontProfitFields.Commission,
    $script:FrontProfitFields.AdSpend,
    $script:FrontProfitFields.RealRevenue,
    $script:FrontProfitFields.FrontProfit,
    $script:FrontProfitFields.PaidRatio
  )) { return 'numeric' }
  return 'text'
}

function Assert-FrontProfitHeaders([object[]]$Headers) {
  if ($Headers.Count -ne $ExpectedFrontProfitColumnCount) {
    throw "Front-profit template must contain $ExpectedFrontProfitColumnCount columns; found $($Headers.Count)."
  }
  if (([Collections.Generic.HashSet[string]]::new([string[]]$Headers)).Count -ne $Headers.Count) {
    throw 'Front-profit template contains duplicate headers.'
  }
  foreach ($field in $FrontProfitCriticalFields) {
    if ($Headers -notcontains $field) {
      throw "Front-profit template is missing a critical field: $field"
    }
  }
}

function New-FrontProfitModuleRequest(
  [object]$Manifest,
  [object]$Inspection,
  [int]$SourceId
) {
  $headers = @($Inspection.headers | ForEach-Object { [string]$_ })
  Assert-FrontProfitHeaders -Headers $headers

  $semanticFields = $Manifest.moduleBuilderMapping.semanticFields
  $roles = [ordered]@{
    time = [string]$semanticFields.time
    amount = [string]$semanticFields.amount
    quantity = [string]$semanticFields.quantity
    shop = [string]$semanticFields.shop
    dimension = [string]$semanticFields.dimension
  }
  $mappedSources = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::Ordinal
  )
  $mappings = @()
  foreach ($entry in $roles.GetEnumerator()) {
    if ($headers -notcontains $entry.Value) {
      throw "Front-profit semantic mapping is missing from the workbook: $($entry.Value)"
    }
    $mappedSources.Add($entry.Value) | Out-Null
    $mappings += [ordered]@{
      semanticRole = [string]$entry.Key
      source = [string]$entry.Value
      label = [string]$entry.Value
      type = Get-FrontProfitColumnType -Header ([string]$entry.Value)
      required = $entry.Key -in @('time', 'amount', 'quantity')
    }
  }

  $additionalFields = @(
    $headers |
      Where-Object { -not $mappedSources.Contains($_) } |
      ForEach-Object {
        [ordered]@{
          source = $_
          label = $_
          type = Get-FrontProfitColumnType -Header $_
        }
      }
  )
  return [ordered]@{
    name = [string]$Manifest.moduleBuilderMapping.name
    category = [string]$Manifest.moduleBuilderMapping.category
    sourceIds = @($SourceId)
    filenamePhrase = [string]$Manifest.moduleBuilderMapping.filenamePhrase
    mappings = $mappings
    additionalFields = $additionalFields
    idempotencyKey = "release-front-profit-$([Guid]::NewGuid().ToString('N').Substring(0, 20))"
  }
}

if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
  $archiveMissingMessage = "Release archive was not found: $ArchivePath"
  # Emit one unformatted line before PowerShell 5.1 renders its wrapped error record.
  [Console]::Error.WriteLine($archiveMissingMessage)
  throw $archiveMissingMessage
}
$resolvedArchive = (Resolve-Path -LiteralPath $ArchivePath).Path
$resolvedWorkingRoot = Resolve-SafeWorkingRoot -Path $WorkingRoot
if ($PreserveEvidence -and -not $UsePublicTestCredentials) {
  throw 'PreserveEvidence requires UsePublicTestCredentials so preserved evidence never contains generated credentials.'
}

if ($UsePublicTestCredentials) {
  # Fixed public placeholders for isolated acceptance only. Never use in production.
  $postgresPassword = 'public-test-only-postgres-not-for-production'
  $appDbPassword = 'public-test-only-app-db-not-for-production'
  $jwtSecret = 'public-test-only-jwt-not-for-production'
  $adminPassword = 'public-test-only-admin-not-for-production'
}
else {
  $postgresPassword = New-CryptoSecret
  $appDbPassword = New-CryptoSecret
  $jwtSecret = New-CryptoSecret
  $adminPassword = New-CryptoSecret
}
$tempRoot = Join-Path $resolvedWorkingRoot ("ec-data-release-" + [Guid]::NewGuid().ToString('N'))
$deployRoot = $null
$project = $null
$ports = $null
$images = @('postgres:16', 'redis:7-alpine', 'deploy-api:latest', 'deploy-web:latest')
$imageSnapshot = $null
$moduleCount = $null
$frontProfitModuleCode = $null
$frontProfitColumnCount = $null
$verifiedChartCount = $null
$verifiedDashboardCount = $null
$runFailure = $null
$attemptedProjects = [Collections.Generic.List[string]]::new()
$acceptanceEnvironmentNames = @(
  'INSTANCE_ID',
  'POSTGRES_PASSWORD',
  'APP_DB_PASSWORD',
  'JWT_SECRET',
  'ADMIN_PASSWORD',
  'DEEPSEEK_API_KEY',
  'CORS_ORIGIN',
  'COMPOSE_PROJECT_NAME',
  'POSTGRES_HOST_PORT',
  'REDIS_HOST_PORT',
  'API_HOST_PORT',
  'WEB_HOST_PORT',
  'POSTGRES_CONTAINER_NAME',
  'REDIS_CONTAINER_NAME',
  'MIGRATE_CONTAINER_NAME',
  'API_CONTAINER_NAME',
  'WEB_CONTAINER_NAME'
)
$environmentSnapshot = if ($PreserveEvidence) {
  Save-ProcessEnvironment -Names $acceptanceEnvironmentNames
}
else {
  $null
}

try {
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  Expand-SafeReleaseArchive -Path $resolvedArchive -DestinationPath $tempRoot

  $topLevel = @(Get-ChildItem -LiteralPath $tempRoot -Force)
  if ($topLevel.Count -ne 1 -or -not $topLevel[0].PSIsContainer -or
      ($topLevel[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Release archive must contain exactly one ordinary top-level directory.'
  }
  $releaseRoot = $topLevel[0].FullName
  $releaseManifest = Assert-ReleasePayloadManifest -ReleaseRoot $releaseRoot
  $deployRoot = Join-Path $releaseRoot 'deploy'
  $composePath = Join-Path $deployRoot 'docker-compose.yml'
  if (-not (Test-Path -LiteralPath $composePath -PathType Leaf)) {
    throw 'Expected deploy/docker-compose.yml in the release archive.'
  }
  $frontProfitBundle = Get-FrontProfitTemplateBundle -ReleaseRoot $releaseRoot
  $imageArchive = Join-Path $releaseRoot 'ec-data-images.tar'
  if (-not (Test-Path -LiteralPath $imageArchive -PathType Leaf)) {
    throw "Offline image archive was not found: $imageArchive"
  }

  Invoke-Native docker @('version')
  $imageSnapshot = Save-ImageTagState -Images $images
  Invoke-Native docker @('load', '-i', $imageArchive)
  Assert-LoadedReleaseImageIds -Manifest $releaseManifest -ImageArchivePath $imageArchive

  $started = $false
  for ($attempt = 1; $attempt -le $MaxStartAttempts; $attempt++) {
    $isolation = New-Isolation
    $project = $isolation.Project
    $attemptedProjects.Add($project) | Out-Null
    $ports = $isolation.Ports
    if ($PreserveEvidence) {
      Set-AcceptanceProcessEnvironment -Project $project -Ports $ports `
        -PostgresPassword $postgresPassword -AppDbPassword $appDbPassword -JwtSecret $jwtSecret `
        -AdminPassword $adminPassword
    }
    Write-AcceptanceEnvironment -DeployRoot $deployRoot -Project $project -Ports $ports `
      -PostgresPassword $postgresPassword -AppDbPassword $appDbPassword -JwtSecret $jwtSecret `
      -AdminPassword $adminPassword

    Push-Location -LiteralPath $deployRoot
    try {
      Assert-IsolatedComposeContract -Project $project
      $started = Start-IsolatedCompose -Project $project
    }
    finally {
      Pop-Location
    }

    if ($started) { break }
    if (-not $PreserveEvidence) {
      Invoke-IsolatedDown -Project $project -DeployRoot $deployRoot
    }
    else {
      Write-Warning "Preserving failed Compose attempt '$project' for review."
    }
    $project = $null
    if ($attempt -eq $MaxStartAttempts) {
      throw "Docker Compose could not allocate isolated host ports after $MaxStartAttempts attempts."
    }
    continue
  }

  $apiBase = "http://localhost:$($ports.API_HOST_PORT)"
  $webBase = "http://localhost:$($ports.WEB_HOST_PORT)"
  $health = Wait-Http -Uri "$apiBase/api/health"
  if (-not $health.ok -or $health.db -ne 'connected') {
    throw "API health check did not confirm a database connection."
  }

  $web = Wait-WebHttp200 -Uri "$webBase/"
  if ($web.StatusCode -ne 200) { throw "Web check returned HTTP $($web.StatusCode)." }

  Push-Location -LiteralPath $deployRoot
  try {
    $roleFlags = (Invoke-Compose -Project $project -Arguments @(
      'exec', '-T', 'postgres', 'psql', '-U', 'ec', '-d', 'ec_data',
      '-At', '-F', ',', '-c',
      "SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = 'ec_app';"
    ) | Out-String).Trim()
    if ($roleFlags -ne 't,f') {
      throw "ec_app must be login-capable and not superuser; received '$roleFlags'."
    }
  }
  finally {
    Pop-Location
  }

  $login = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/auth/login" `
    -Method 'POST' `
    -Body @{ username = 'admin'; password = $adminPassword }
  $token = [string]$login.data.token
  if (-not $login.ok -or [string]::IsNullOrWhiteSpace($token) -or
      $login.data.user.username -ne 'admin' -or -not $login.data.user.isAdmin) {
    throw "Admin login did not return an authenticated administrator."
  }

  $modules = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/modules" `
    -Token $token
  if (-not $modules.ok -or $null -eq $modules.data -or @($modules.data).Count -eq 0) {
    throw "Authenticated module check returned no modules."
  }
  $preexistingUserModules = @(
    $modules.data | Where-Object { $_.origin -eq 'user' }
  )
  if ($preexistingUserModules.Count -ne 0) {
    throw "Isolated acceptance database was not blank for user modules; found $($preexistingUserModules.Count)."
  }
  $moduleCount = @($modules.data).Count

  $frontProfitAcceptancePath = New-FrontProfitAcceptanceCsv -Directory $frontProfitBundle.Root
  $upload = Invoke-FrontProfitTemplateUpload `
    -Uri "$apiBase/api/files/upload" `
    -Token $token `
    -TemplatePath $frontProfitAcceptancePath
  if (-not $upload.ok -or $null -eq $upload.data) {
    throw 'Front-profit template upload did not return a successful data source.'
  }
  $frontProfitValidation = $upload.data.frontProfitValidation
  if ($null -eq $frontProfitValidation) {
    throw 'Front-profit upload did not execute the dedicated validation gate.'
  }
  foreach ($propertyName in @('schemaVersion', 'businessRowCount', 'warningCount', 'warningCodes')) {
    if ($null -eq $frontProfitValidation.PSObject.Properties[$propertyName]) {
      throw "Front-profit upload validation summary is missing ${propertyName}."
    }
  }
  if ($frontProfitValidation.warningCodes -isnot [array]) {
    throw 'Front-profit upload validation warningCodes must be an array.'
  }
  if ([string]$frontProfitValidation.schemaVersion -ne 'front-profit-standard/v1') {
    throw 'Front-profit upload returned an unexpected validation schema version.'
  }
  if ([int]$frontProfitValidation.businessRowCount -ne 1) {
    throw 'Front-profit upload validation did not accept exactly one synthetic business row.'
  }
  if (
    [int]$frontProfitValidation.warningCount -ne 0 -or
    @($frontProfitValidation.warningCodes).Count -ne 0
  ) {
    throw 'Front-profit upload validation returned unexpected warnings.'
  }
  $sourceId = [int]$upload.data.sourceId
  $uploadedHeaders = @(
    $upload.data.columns | ForEach-Object { [string]$_.raw }
  )
  if ($sourceId -le 0) {
    throw 'Front-profit template upload returned an invalid source id.'
  }
  Assert-FrontProfitHeaders -Headers $uploadedHeaders

  $inspection = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/modules/inspect-sources" `
    -Method 'POST' `
    -Token $token `
    -Body @{
      sourceIds = @($sourceId)
      includeStatusValues = $false
    }
  if (-not $inspection.ok -or -not $inspection.data.compatible) {
    throw 'Front-profit source inspection did not confirm compatible headers.'
  }
  $inspectedHeaders = @(
    $inspection.data.headers | ForEach-Object { [string]$_ }
  )
  Assert-FrontProfitHeaders -Headers $inspectedHeaders
  if (($uploadedHeaders -join "`n") -ne ($inspectedHeaders -join "`n")) {
    throw 'Front-profit uploaded and inspected header orders differ.'
  }

  $createRequest = New-FrontProfitModuleRequest `
    -Manifest $frontProfitBundle.Manifest `
    -Inspection $inspection.data `
    -SourceId $sourceId
  $created = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/modules" `
    -Method 'POST' `
    -Token $token `
    -Body $createRequest
  if (-not $created.ok -or $null -eq $created.data) {
    throw 'Front-profit user module creation did not return a successful result.'
  }
  $processingFiles = @($created.data.files)
  if (
    $processingFiles.Count -ne 1 -or
    @($processingFiles | Where-Object { $_.status -ne 'success' }).Count -ne 0
  ) {
    throw 'Front-profit template processing did not complete successfully.'
  }
  if (
    [int]$processingFiles[0].total -lt 1 -or
    [int]$processingFiles[0].inserted -lt 1 -or
    [int]$processingFiles[0].included -lt 1
  ) {
    throw 'Front-profit template processing did not retain its synthetic acceptance row.'
  }
  $frontProfitModuleCode = [string]$created.data.moduleCode
  if ($frontProfitModuleCode -notmatch '^[a-z][a-z0-9_]*$') {
    throw 'Front-profit module creation returned an invalid module code.'
  }

  $createdModule = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/modules/$([Uri]::EscapeDataString($frontProfitModuleCode))" `
    -Token $token
  if (-not $createdModule.ok -or $null -eq $createdModule.data) {
    throw 'Front-profit module could not be reloaded after creation.'
  }
  if ($createdModule.data.name -ne $script:FrontProfitFields.ModuleName) {
    throw 'Front-profit module name does not match the template contract.'
  }
  $createdColumns = @($createdModule.data.columns)
  $frontProfitColumnCount = $createdColumns.Count
  if ($frontProfitColumnCount -ne $ExpectedFrontProfitColumnCount) {
    throw "Front-profit module must expose $ExpectedFrontProfitColumnCount columns; found $frontProfitColumnCount."
  }
  $createdSources = @(
    $createdColumns | ForEach-Object {
      if ($_.source -is [array]) { $_.source } else { [string]$_.source }
    }
  )
  foreach ($field in $FrontProfitCriticalFields) {
    if ($createdSources -notcontains $field) {
      throw "Front-profit module is missing a critical source field: $field"
    }
  }

  $moduleCharts = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/board/charts?moduleCode=$([Uri]::EscapeDataString($frontProfitModuleCode))" `
    -Token $token
  $chartsForModule = @($moduleCharts.data)
  if (-not $moduleCharts.ok -or $chartsForModule.Count -lt 1) {
    throw 'Front-profit module creation did not produce a renderable default chart.'
  }
  $verifiedChartCount = $chartsForModule.Count
  $chartId = [int]$chartsForModule[0].id
  $render = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/board/charts/$chartId/render" `
    -Token $token
  if (
    -not $render.ok -or
    -not $render.data.complete -or
    $render.data.truncated -or
    @($render.data.rows).Count -lt 1
  ) {
    throw 'Front-profit default chart did not render one complete synthetic result.'
  }

  $dashboard = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/board/dashboards" `
    -Method 'POST' `
    -Token $token `
    -Body @{
      name = 'Release verifier dashboard'
      description = 'Synthetic isolated acceptance only'
      layout = @(@{ chartId = $chartId; x = 0; y = 0; w = 6; h = 4 })
    }
  $dashboardId = [int]$dashboard.data.id
  if (-not $dashboard.ok -or $dashboardId -le 0) {
    throw 'Release verifier dashboard creation failed.'
  }
  $verifiedDashboardCount = 1

  $backupRoot = Join-Path $tempRoot 'instance-backups'
  New-Item -ItemType Directory -Path $backupRoot | Out-Null
  Invoke-InstanceOperatorScript `
    -Path (Join-Path $releaseRoot 'backup.ps1') `
    -Arguments @('-OutputRoot', $backupRoot)
  $backupDirectories = @(Get-ChildItem -LiteralPath $backupRoot -Directory -Force)
  if ($backupDirectories.Count -ne 1) {
    throw 'Release backup did not create exactly one validated backup directory.'
  }

  $removedDashboard = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/board/dashboards/$dashboardId" `
    -Method 'DELETE' `
    -Token $token
  if (-not $removedDashboard.ok) {
    throw 'Could not create the post-backup mutation used by the restore check.'
  }
  $dashboardsAfterMutation = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/board/dashboards" `
    -Token $token
  if (@($dashboardsAfterMutation.data | Where-Object { [int]$_.id -eq $dashboardId }).Count -ne 0) {
    throw 'The post-backup dashboard mutation was not visible before restore.'
  }

  Invoke-InstanceOperatorScript `
    -Path (Join-Path $releaseRoot 'restore.ps1') `
    -Arguments @(
      '-BackupPath', $backupDirectories[0].FullName,
      '-ConfirmInstanceId', $project,
      '-AcknowledgeDataOverwrite'
    )
  $restoredHealth = Wait-Http -Uri "$apiBase/api/health"
  if (-not $restoredHealth.ok -or $restoredHealth.db -ne 'connected') {
    throw 'Restored API did not return to a healthy database connection.'
  }
  $restoredLogin = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/auth/login" `
    -Method 'POST' `
    -Body @{ username = 'admin'; password = $adminPassword }
  $restoredToken = [string]$restoredLogin.data.token
  if (-not $restoredLogin.ok -or [string]::IsNullOrWhiteSpace($restoredToken)) {
    throw 'Admin login failed after instance restore.'
  }
  $restoredModule = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/modules/$([Uri]::EscapeDataString($frontProfitModuleCode))" `
    -Token $restoredToken
  $restoredDashboards = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/board/dashboards" `
    -Token $restoredToken
  $restoredRender = Invoke-Utf8JsonApi `
    -Uri "$apiBase/api/board/charts/$chartId/render" `
    -Token $restoredToken
  if (
    -not $restoredModule.ok -or
    @($restoredDashboards.data | Where-Object { [int]$_.id -eq $dashboardId }).Count -ne 1 -or
    -not $restoredRender.ok -or
    -not $restoredRender.data.complete -or
    @($restoredRender.data.rows).Count -lt 1
  ) {
    throw 'Backup restore did not recover the module, dashboard, and renderable chart.'
  }
}
catch {
  $runFailure = $_.Exception
}
finally {
  $cleanupFailures = [Collections.Generic.List[string]]::new()
  if ($PreserveEvidence) {
    Write-Host "Evidence root preserved: $tempRoot"
    if ($attemptedProjects.Count -gt 0) {
      Write-Host "Compose project evidence preserved: $($attemptedProjects -join ', ')"
    }
    Write-Host 'PreserveEvidence skipped Compose, volume, image-tag, and extracted-file cleanup.'
  }
  else {
    if ($project -and $deployRoot) {
      try {
        Invoke-IsolatedDown -Project $project -DeployRoot $deployRoot
      }
      catch {
        $cleanupFailures.Add("Compose cleanup: $($_.Exception.Message)") | Out-Null
      }
    }
    if ($null -ne $imageSnapshot) {
      try {
        Restore-ImageTags -Snapshot $imageSnapshot -Images $images
      }
      catch {
        $cleanupFailures.Add("Image cleanup: $($_.Exception.Message)") | Out-Null
      }
    }
    if (Test-Path -LiteralPath $tempRoot) {
      try {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
      }
      catch {
        $cleanupFailures.Add("Temp cleanup: $($_.Exception.Message)") | Out-Null
      }
    }
  }
  if ($null -ne $environmentSnapshot) {
    try {
      Restore-ProcessEnvironment -Snapshot $environmentSnapshot
    }
    catch {
      $cleanupFailures.Add("Process environment restoration: $($_.Exception.Message)") | Out-Null
    }
  }

  if ($runFailure -or $cleanupFailures.Count -gt 0) {
    $failureMessages = [Collections.Generic.List[string]]::new()
    if ($runFailure) { $failureMessages.Add("Verification: $($runFailure.Message)") | Out-Null }
    foreach ($cleanupFailure in $cleanupFailures) { $failureMessages.Add($cleanupFailure) | Out-Null }
    throw ($failureMessages -join [Environment]::NewLine)
  }
}

Write-Host "Verified ec_app role, API health, Web HTTP 200, admin login, $moduleCount baseline modules, front-profit user-module creation with $frontProfitColumnCount columns, $verifiedChartCount rendered chart(s), $verifiedDashboardCount dashboard, and backup/restore recovery."
