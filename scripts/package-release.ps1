[CmdletBinding()]
param(
  [string]$OutputRoot,
  [string]$PrebuiltImageArchive = $env:PREBUILT_IMAGE_ARCHIVE,
  [string]$PrebuiltImageProvenance = $env:PREBUILT_IMAGE_PROVENANCE,
  [switch]$SkipImageExport,
  [switch]$SkipFrontProfitLocalPrecheck,
  [switch]$PreserveStaging
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'sha256.ps1')
if (-not $OutputRoot) { $OutputRoot = Join-Path $RepoRoot 'release' }
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:StrictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
$humanModuleGuideName = (-join @([char]0x52A0, [char]0x6A21, [char]0x5757)) + '_' + (-join @([char]0x7ED9, [char]0x4EBA, [char]0x770B)) + '.md'
$deploymentGuideName = (-join @([char]0x90E8, [char]0x7F72, [char]0x6307, [char]0x5357)) + '.md'
$offlineGuideName = (-join @([char]0x79BB, [char]0x7EBF, [char]0x5305, [char]0x4F7F, [char]0x7528, [char]0x8BF4, [char]0x660E)) + '.md'
$releaseDocNames = @(
  'GETTING_STARTED.md',
  'DEPENDENCY_SECURITY_2026-10-08.md',
  'HOW_TO_ADD_MODULE.md',
  'HOW_TO_ADD_PLATFORM.md',
  'SELF_SERVICE_MODULES.md',
  'DIY_SEMANTIC_EXTENSIONS.md',
  'USER_GUIDE.md',
  'AI_DIY_GUIDE.md',
  'AI_PROMPTS.md',
  $humanModuleGuideName,
  $deploymentGuideName,
  $offlineGuideName
)
$templateWorkbookNames = @(
  $script:StrictUtf8.GetString([Convert]::FromBase64String('MDEt55S15ZWG5YmN5Y+w5Yip5ram5Y2V6KGo5LiK5Lyg5qih5p2/Lnhsc3g=')),
  $script:StrictUtf8.GetString([Convert]::FromBase64String('MDIt55S15ZWG5YmN5Y+w5Yip5ram5pWw5o2u5YeG5aSH5LiO5pig5bCE5qih5p2/Lnhsc3g='))
)
$templateFileNames = @(
  $templateWorkbookNames[0],
  $templateWorkbookNames[1],
  $script:StrictUtf8.GetString([Convert]::FromBase64String('UkVBRE1FLeWJjeWPsOWIqea2puaooeadv+S9v+eUqOivtOaYji5tZA==')),
  'template-manifest.json',
  'SHA256SUMS.txt'
)

function Invoke-Native([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}

function Assert-NoComposeControlEnvironment {
  $override = @(
    Get-ChildItem Env: | Where-Object { $_.Name -like 'COMPOSE_*' } |
      Select-Object -First 1
  )
  if ($override.Count -gt 0) {
    throw "Local image build refuses Docker Compose control variable: $($override[0].Name)"
  }
}

function Invoke-FrontProfitLocalReleasePrecheck {
  if ($SkipFrontProfitLocalPrecheck) {
    Write-Warning 'Skipping front-profit local release precheck; use this only for structural package tests.'
    return
  }
  Invoke-Native pnpm @('--filter', '@ec/api', 'run', 'front-profit:local-release-precheck')
}

function Assert-SafeChildPath([string]$Parent, [string]$Child) {
  $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $childFull = [IO.Path]::GetFullPath($Child)
  if (-not $childFull.StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe release path: $childFull"
  }
}

function Resolve-SafeReleaseRoot([string]$CandidateRoot) {
  $candidateFull = [IO.Path]::GetFullPath($CandidateRoot).TrimEnd('\')
  $pathRoot = [IO.Path]::GetPathRoot($candidateFull).TrimEnd('\')
  if ($candidateFull.Equals($pathRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot cannot be a filesystem root: $candidateFull"
  }
  return $candidateFull
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, $script:Utf8NoBom)
}

function Convert-StagedShellScriptsToUtf8Lf([string]$Root) {
  $shellScripts = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter '*.sh')
  $normalizedScripts = @(foreach ($shellScript in $shellScripts) {
    $path = $shellScript.FullName
    $bytes = [IO.File]::ReadAllBytes($path)
    $offset = 0
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      $offset = 3
    }
    try {
      $content = $script:StrictUtf8.GetString($bytes, $offset, $bytes.Length - $offset)
    }
    catch [System.Text.DecoderFallbackException] {
      throw "Shell script is not valid UTF-8: $path"
    }
    $content = $content.Replace("`r`n", "`n").Replace("`r", "`n")
    [PSCustomObject]@{ Path = $path; Content = $content }
  })

  foreach ($scriptFile in $normalizedScripts) {
    Write-Utf8NoBom $scriptFile.Path $scriptFile.Content
  }
}

function Get-ReleaseFileRecords([string]$Root) {
  $manifestPath = Join-Path $Root 'release-manifest.json'
  $reparsePoints = @(Get-ChildItem -LiteralPath $Root -Recurse -Force | Where-Object {
    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  })
  if ($reparsePoints.Count -gt 0) { throw 'Release payload must not contain reparse points.' }
  return @(
    Get-ChildItem -LiteralPath $Root -Recurse -File | Where-Object {
      $_.FullName -cne $manifestPath
    } | ForEach-Object {
      [ordered]@{
        path = $_.FullName.Substring($Root.Length + 1).Replace('\', '/')
        size = [int64]$_.Length
        sha256 = Get-Sha256Hex $_.FullName
      }
    } | Sort-Object { $_.path }
  )
}

function Read-PrebuiltImageProvenance(
  [string]$Path,
  [string]$ArchivePath,
  [string]$SourceRevision,
  [string[]]$RequiredImages
) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Prebuilt image provenance was not found: $Path"
  }
  $value = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Path).Path, $script:StrictUtf8) | ConvertFrom-Json
  if ($value -isnot [pscustomobject]) { throw 'Prebuilt image provenance must be a JSON object.' }
  $rootProperties = @($value.PSObject.Properties | ForEach-Object { $_.Name })
  if ([string]::Join("`n", $rootProperties) -cne "schemaVersion`nsourceRevision`narchiveSha256`nimages" -or
      [int]$value.schemaVersion -ne 1 -or [string]$value.sourceRevision -cne $SourceRevision -or
      [string]$value.archiveSha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Prebuilt image provenance has invalid canonical root metadata.'
  }
  $actualArchiveHash = Get-Sha256Hex $ArchivePath
  if ([string]$value.archiveSha256 -cne $actualArchiveHash) {
    throw 'Prebuilt image provenance archiveSha256 does not match the supplied archive.'
  }
  if ($value.images -isnot [pscustomobject]) { throw 'Prebuilt image provenance images must be an object.' }
  $properties = @($value.images.PSObject.Properties)
  if ($properties.Count -ne $RequiredImages.Count) { throw 'Prebuilt image provenance must contain exactly the required images.' }
  if ([string]::Join("`n", @($properties | ForEach-Object { $_.Name })) -cne [string]::Join("`n", $RequiredImages)) {
    throw 'Prebuilt image provenance images must use canonical order.'
  }
  $result = [ordered]@{}
  foreach ($image in $RequiredImages) {
    $provenanceMatches = @($properties | Where-Object { $_.Name -ceq $image })
    if ($provenanceMatches.Count -ne 1 -or $provenanceMatches[0].Value -isnot [pscustomobject]) {
      throw "Prebuilt image provenance is missing or invalid for $image."
    }
    $entry = $provenanceMatches[0].Value
    $entryProperties = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
    $expectedProperties = "imageId`nregistryRepository`ndigest`nreference"
    if ([string]::Join("`n", $entryProperties) -cne $expectedProperties -or
        [string]$entry.imageId -cnotmatch '^sha256:[0-9a-f]{64}$') {
      throw "Prebuilt image provenance has invalid canonical metadata for $image."
    }
    $repository = [string]$entry.registryRepository
    $digest = [string]$entry.digest
    if ($repository -cnotmatch '^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+$' -or
        $digest -cnotmatch '^sha256:[0-9a-f]{64}$' -or
        [string]$entry.reference -cne ($repository + '@' + $digest)) {
      throw "Prebuilt image provenance has invalid registry evidence for $image."
    }
    $result[$image] = [string]$entry.imageId
  }
  return $result
}

function Assert-FrontProfitTemplateDirectory([string]$TemplateRoot) {
  if (-not (Test-Path -LiteralPath $TemplateRoot -PathType Container)) {
    throw "Front-profit template directory is missing: $TemplateRoot"
  }

  $directories = @(Get-ChildItem -LiteralPath $TemplateRoot -Recurse -Force -Directory)
  $actualFiles = @(
    Get-ChildItem -LiteralPath $TemplateRoot -Recurse -Force -File | ForEach-Object {
      $_.FullName.Substring($TemplateRoot.Length + 1).Replace('\', '/')
    } | Sort-Object
  )
  $expectedFiles = @($templateFileNames | Sort-Object)
  if ($directories.Count -gt 0 -or [string]::Join("`n", $actualFiles) -cne [string]::Join("`n", $expectedFiles)) {
    throw "Front-profit templates do not match the exact allowlist: $($actualFiles -join ', ')"
  }

  $manifestPath = Join-Path $TemplateRoot 'template-manifest.json'
  $manifest = [IO.File]::ReadAllText($manifestPath, $script:StrictUtf8) | ConvertFrom-Json
  if ($manifest.containsRealBusinessData -ne $false) {
    throw 'Front-profit template manifest must declare containsRealBusinessData=false.'
  }

  $manifestFiles = @($manifest.files)
  $manifestNames = @($manifestFiles | ForEach-Object { [string]$_.name } | Sort-Object)
  $expectedWorkbookNames = @($templateWorkbookNames | Sort-Object)
  if ([string]::Join("`n", $manifestNames) -cne [string]::Join("`n", $expectedWorkbookNames)) {
    throw "Front-profit template manifest does not list the exact workbook allowlist: $($manifestNames -join ', ')"
  }

  $manifestHashes = @{}
  foreach ($entry in $manifestFiles) {
    $name = [string]$entry.name
    $declaredHash = ([string]$entry.sha256).ToUpperInvariant()
    if ($declaredHash -notmatch '^[0-9A-F]{64}$') {
      throw "Invalid front-profit template SHA-256 in manifest: $name"
    }
    if ($null -eq $entry.businessDataRows -or [int64]$entry.businessDataRows -ne 0) {
      throw "Front-profit template manifest must declare businessDataRows=0: $name"
    }
    $actualHash = (Get-Sha256Hex (Join-Path $TemplateRoot $name)).ToUpperInvariant()
    if ($actualHash -cne $declaredHash) {
      throw "Front-profit template SHA-256 mismatch: $name"
    }
    $manifestHashes[$name] = $declaredHash
  }

  $sumPath = Join-Path $TemplateRoot 'SHA256SUMS.txt'
  $sumLines = @([IO.File]::ReadAllLines($sumPath, $script:StrictUtf8) | Where-Object { $_.Length -gt 0 })
  if ($sumLines.Count -ne $templateWorkbookNames.Count) {
    throw 'Front-profit SHA256SUMS.txt must contain exactly the two allowed workbooks.'
  }
  $sumNames = @()
  foreach ($line in $sumLines) {
    $match = [regex]::Match($line, '^([0-9A-Fa-f]{64})  (.+)$')
    if (-not $match.Success) { throw 'Invalid front-profit SHA256SUMS.txt line.' }
    $sumHash = $match.Groups[1].Value.ToUpperInvariant()
    $sumName = $match.Groups[2].Value
    if (-not $manifestHashes.ContainsKey($sumName) -or $manifestHashes[$sumName] -cne $sumHash) {
      throw "Front-profit SHA256SUMS.txt does not match the manifest: $sumName"
    }
    $sumNames += $sumName
  }
  if ([string]::Join("`n", @($sumNames | Sort-Object)) -cne [string]::Join("`n", $expectedWorkbookNames)) {
    throw 'Front-profit SHA256SUMS.txt does not list the exact workbook allowlist.'
  }
}

function Assert-ReleaseTree([string]$Root) {
  # Keep the source ASCII-safe for Windows PowerShell 5.1 without a BOM.
  $conversationArchiveName = -join @([char]0x5BF9, [char]0x8BDD, [char]0x6536, [char]0x96C6)
  $forbiddenNames = @('.env', '.env.local', '.git', 'node_modules', 'spec', $conversationArchiveName)
  $forbiddenExtensions = @('.xlsx', '.xls', '.csv', '.sqlite', '.dump', '.bak', '.backup', '.log')
  $allowedTemplateWorkbookPaths = @($templateWorkbookNames | ForEach-Object { "templates/front-profit/$_" })
  $violations = Get-ChildItem -LiteralPath $Root -Recurse -Force | Where-Object {
    $isFile = -not $_.PSIsContainer
    $lowerName = $_.Name.ToLowerInvariant()
    $relativePath = if ($isFile) { $_.FullName.Substring($Root.Length + 1).Replace('\', '/') } else { '' }
    $isAllowedTemplateWorkbook = $isFile -and ($allowedTemplateWorkbookPaths -ccontains $relativePath)
    $isForbiddenEnvironmentFile = $isFile -and $lowerName -ne '.env.example' -and (
      $lowerName -eq '.env' -or $lowerName -like '.env.*' -or $lowerName -like '*.env'
    )
    ($forbiddenNames -contains $lowerName -and $lowerName -ne '.env.example') -or
    ($isFile -and -not $isAllowedTemplateWorkbook -and $forbiddenExtensions -contains $_.Extension.ToLowerInvariant()) -or
    $isForbiddenEnvironmentFile
  }
  if ($violations) { throw "Forbidden release content: $($violations.FullName -join ', ')" }

  Assert-FrontProfitTemplateDirectory (Join-Path $Root 'templates\front-profit')

  $docsRoot = Join-Path $Root 'docs'
  $actualDocs = @(
    Get-ChildItem -LiteralPath $docsRoot -Recurse -File | ForEach-Object {
      $_.FullName.Substring($docsRoot.Length + 1).Replace('\', '/')
    } | Sort-Object
  )
  $expectedDocs = @($releaseDocNames | Sort-Object)
  if ([string]::Join("`n", $actualDocs) -ne [string]::Join("`n", $expectedDocs)) {
    throw "Release docs do not match the recipient allowlist: $($actualDocs -join ', ')"
  }
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

function Assert-ReleaseManifest([string]$Root) {
  $manifestPath = Join-Path $Root 'release-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Release manifest is missing: $manifestPath"
  }
  $archiveExists = Test-Path -LiteralPath (Join-Path $Root 'ec-data-images.tar') -PathType Leaf
  $manifestJson = [IO.File]::ReadAllText($manifestPath, $script:StrictUtf8)
  $requiredManifestProperties = @('name', 'createdAt', 'sourceRevision', 'imageSource', 'images', 'imageIds', 'files')
  if ($archiveExists) { $requiredManifestProperties += $images }
  foreach ($propertyName in $requiredManifestProperties) {
    $propertyPattern = [regex]::Escape('"' + $propertyName + '"') + '\s*:'
    if ([regex]::Matches($manifestJson, $propertyPattern).Count -ne 1) {
      throw "Release manifest must contain exactly one property named ${propertyName}."
    }
  }
  $manifest = $manifestJson | ConvertFrom-Json
  if ($manifest -isnot [pscustomobject]) { throw 'Release manifest root must be an object.' }
  $expectedRootProperties = @('name', 'createdAt', 'sourceRevision', 'imageSource', 'images', 'imageIds', 'files')
  $actualRootProperties = @($manifest.PSObject.Properties | ForEach-Object { $_.Name })
  if ([string]::Join("`n", $actualRootProperties) -cne [string]::Join("`n", $expectedRootProperties)) {
    throw 'Release manifest must contain exactly the canonical ordered root properties.'
  }
  if (-not (Test-CanonicalUtcJsonTimestamp -Json $manifestJson -PropertyName 'createdAt')) {
    throw 'Release manifest createdAt must be a canonical timestamp.'
  }
  $expectedImageSource = if ($archiveExists) { if (Test-Path -LiteralPath (Join-Path $Root 'image-provenance.json')) { 'prebuilt-archive' } else { 'local-build' } } else { 'structural-no-images' }
  if ([string]$manifest.imageSource -cne $expectedImageSource) { throw 'Release manifest imageSource does not match its payload.' }
  $manifestImages = @($manifest.images | ForEach-Object { [string]$_ })
  if ($manifest.images -is [string] -or $manifestImages.Count -ne $images.Count -or
      [string]::Join("`n", $manifestImages) -cne [string]::Join("`n", $images)) {
    throw 'Release manifest images must exactly match the required image list.'
  }
  if ($manifest.imageIds -isnot [pscustomobject]) {
    throw 'Release manifest imageIds must be an object.'
  }
  $imageIdProperties = @($manifest.imageIds.PSObject.Properties)
  $contractPath = Join-Path $Root 'release-image-ids.txt'
  if ($archiveExists) {
    if ($imageIdProperties.Count -ne $images.Count) {
      throw 'Release manifest imageIds must contain exactly the required images.'
    }
    $contractLines = @()
    foreach ($image in $images) {
      $imageIdMatches = @($imageIdProperties | Where-Object { $_.Name -ceq $image })
      $imageIdValue = if ($imageIdMatches.Count -eq 1) { [string]$imageIdMatches[0].Value } else { '' }
      if ($imageIdMatches.Count -ne 1 -or -not [regex]::IsMatch($imageIdValue, '^sha256:[0-9a-f]{64}$')) {
        throw "Release manifest has a missing or invalid image ID for $image."
      }
      $contractLines += $image + '=' + $imageIdValue
    }
    if (-not (Test-Path -LiteralPath $contractPath -PathType Leaf)) {
      throw 'Release image-ID contract is missing.'
    }
    $actualContract = [IO.File]::ReadAllText($contractPath, $script:StrictUtf8)
    $expectedContract = [string]::Join("`n", $contractLines) + "`n"
    $contractMatches = [string]::Equals($actualContract, $expectedContract, [StringComparison]::Ordinal)
    if (-not $contractMatches) {
      Start-Sleep -Milliseconds 250
      $actualContract = [IO.File]::ReadAllText($contractPath, $script:StrictUtf8)
      $contractMatches = [string]::Equals($actualContract, $expectedContract, [StringComparison]::Ordinal)
    }
    if (-not $contractMatches) {
      throw 'Release image-ID contract does not exactly match the manifest.'
    }
  }
  elseif ($imageIdProperties.Count -ne 0 -or (Test-Path -LiteralPath $contractPath)) {
    throw 'A structural package without an image archive must not contain image IDs.'
  }
  if ($manifest.files -isnot [System.Array]) { throw 'Release manifest files must be an array.' }
  $listed = @($manifest.files)
  $actual = @(Get-ReleaseFileRecords $Root)
  if ($listed.Count -ne $actual.Count) { throw 'Release manifest file records do not match the staged payload.' }
  for ($index = 0; $index -lt $actual.Count; $index++) {
    $entry = $listed[$index]
    $properties = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
    if ($entry -isnot [pscustomobject] -or
        [string]::Join("`n", $properties) -cne "path`nsize`nsha256" -or
        [string]$entry.path -cne [string]$actual[$index].path -or
        [int64]$entry.size -ne [int64]$actual[$index].size -or
        [string]$entry.sha256 -cne [string]$actual[$index].sha256) {
      throw 'Release manifest file records do not match the staged payload.'
    }
  }
}

$OutputRoot = Resolve-SafeReleaseRoot $OutputRoot
$images = @('postgres:16', 'redis:7-alpine', 'deploy-api:latest', 'deploy-web:latest')
$composeFile = Join-Path $RepoRoot 'deploy\docker-compose.yml'
$composeEnvironmentFile = Join-Path $RepoRoot 'deploy\.env.example'
$distName = 'ec-data-platform-' + (Get-Date -Format 'yyyyMMdd')
$stagingNonce = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$stagingRoot = Join-Path $OutputRoot ('.s-' + $stagingNonce)
$distRoot = Join-Path $stagingRoot $distName
$zipTemp = Join-Path $stagingRoot ($distName + '.zip')
$zipFinal = Join-Path $OutputRoot ($distName + '.zip')
$zipHash = $null
$zipBytes = $null
$sourceRevision = 'not-exported'
$imageIds = [ordered]@{}
$imageSource = if ($SkipImageExport) { 'structural-no-images' } elseif ($PrebuiltImageArchive) { 'prebuilt-archive' } else { 'local-build' }

if (($PrebuiltImageArchive -and -not $PrebuiltImageProvenance) -or
    ($PrebuiltImageProvenance -and -not $PrebuiltImageArchive)) {
  throw 'PrebuiltImageArchive and PrebuiltImageProvenance must be supplied together.'
}
if ($SkipImageExport -and ($PrebuiltImageArchive -or $PrebuiltImageProvenance)) {
  throw 'SkipImageExport cannot be combined with prebuilt image inputs.'
}

New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
Assert-SafeChildPath $OutputRoot $stagingRoot

try {
  New-Item -ItemType Directory -Path $distRoot -Force | Out-Null

  if (-not $SkipImageExport) {
    $sourceStatus = @(& git -C $RepoRoot status --porcelain --untracked-files=normal)
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the source worktree.' }
    if ($sourceStatus.Count -gt 0) { throw 'Refusing to package a dirty source worktree.' }
    $sourceRevision = (& git -C $RepoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $sourceRevision) { throw 'Could not resolve the source revision.' }

    if ($PrebuiltImageArchive) {
      $resolvedPrebuiltArchive = (Resolve-Path -LiteralPath $PrebuiltImageArchive).Path
      $resolvedPrebuiltProvenance = (Resolve-Path -LiteralPath $PrebuiltImageProvenance).Path
      $provenanceImageIds = Read-PrebuiltImageProvenance $resolvedPrebuiltProvenance $resolvedPrebuiltArchive $sourceRevision $images
      Invoke-FrontProfitLocalReleasePrecheck
      Invoke-Native docker @('load', '-i', $resolvedPrebuiltArchive)
    }
    else {
      Assert-NoComposeControlEnvironment
      Invoke-FrontProfitLocalReleasePrecheck
      Invoke-Native docker @(
        'compose', '--env-file', $composeEnvironmentFile,
        '-f', $composeFile, 'build', '--pull', 'api', 'web'
      )
    }
    foreach ($image in $images) { Invoke-Native docker @('image', 'inspect', $image) }
    foreach ($image in $images) {
      $imageId = (& docker image inspect --format '{{.Id}}' $image).Trim()
      if ($LASTEXITCODE -ne 0 -or -not $imageId) { throw "Could not resolve image ID for $image" }
      if ($PrebuiltImageArchive -and [string]$provenanceImageIds[$image] -cne $imageId) {
        throw "Loaded image ID does not match prebuilt provenance for $image."
      }
      $imageIds[$image] = $imageId
    }
    if ($PrebuiltImageArchive) {
      Copy-Item -LiteralPath $resolvedPrebuiltArchive -Destination (Join-Path $distRoot 'ec-data-images.tar')
      Copy-Item -LiteralPath $resolvedPrebuiltProvenance -Destination (Join-Path $distRoot 'image-provenance.json')
    }
    else {
      Invoke-Native docker (@('save') + $images + @('-o', (Join-Path $distRoot 'ec-data-images.tar')))
    }
  }

  Copy-Item -LiteralPath (Join-Path $RepoRoot 'deploy') -Destination (Join-Path $distRoot 'deploy') -Recurse
  $releaseDocsRoot = Join-Path $distRoot 'docs'
  New-Item -Path $releaseDocsRoot -ItemType Directory -Force | Out-Null
  foreach ($docName in $releaseDocNames) {
    $sourceDoc = Join-Path (Join-Path $RepoRoot 'docs') $docName
    if (-not (Test-Path -LiteralPath $sourceDoc -PathType Leaf)) { throw "Required release doc is missing: $sourceDoc" }
    Copy-Item -LiteralPath $sourceDoc -Destination (Join-Path $releaseDocsRoot $docName)
  }
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'LICENSE') -Destination (Join-Path $distRoot 'LICENSE')
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $distRoot 'THIRD_PARTY_NOTICES.md')
  $sourceTemplateRoot = Join-Path $RepoRoot 'templates\front-profit'
  Assert-FrontProfitTemplateDirectory $sourceTemplateRoot
  $releaseTemplateParent = Join-Path $distRoot 'templates'
  New-Item -Path $releaseTemplateParent -ItemType Directory -Force | Out-Null
  Copy-Item -LiteralPath $sourceTemplateRoot -Destination $releaseTemplateParent -Recurse
  $releaseApiRoot = Join-Path $distRoot 'apps\api'
  $releaseModulesRoot = Join-Path $releaseApiRoot 'src\modules'
  $releaseExtensionsRoot = Join-Path $releaseApiRoot 'extensions'
  New-Item -Path $releaseModulesRoot -ItemType Directory -Force | Out-Null
  New-Item -Path $releaseExtensionsRoot -ItemType Directory -Force | Out-Null
  foreach ($sourceItem in @(Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'apps\api\src\modules') -Force)) {
    Copy-Item -LiteralPath $sourceItem.FullName -Destination $releaseModulesRoot -Recurse -Force
  }
  foreach ($sourceItem in @(Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'apps\api\extensions') -Force)) {
    Copy-Item -LiteralPath $sourceItem.FullName -Destination $releaseExtensionsRoot -Recurse -Force
  }
  Remove-Item -LiteralPath (Join-Path $distRoot 'deploy\.env') -Force -ErrorAction SilentlyContinue
  $readme = @'
# ec-data-platform offline runtime

## Start here: choose your reader

- First download: [GitHub download and first startup](docs/GETTING_STARTED.md).
- Dependency fixes and limitations: [Dependency security report](docs/DEPENDENCY_SECURITY_2026-10-08.md).
- Human users: [Installation and usage manual](docs/USER_GUIDE.md).
- Development AI: [Handoff and DIY guide](docs/AI_DIY_GUIDE.md).
- Copyable AI task prompts: [Prompt collection](docs/AI_PROMPTS.md).

Existing installation? Do not launch a second copy. Back up and follow the upgrade guidance first.

1. Install and start Docker Desktop.
2. Copy `deploy/.env.example` to `deploy/.env` and replace every `change_me` value.
3. Run `start.bat` on Windows or `bash start.sh` on macOS/Linux.
4. Open http://localhost:3997 after all services become healthy.
5. Use `backup.ps1` / `backup.sh` for an integrity-checked instance backup; restore requires the matching `restore` script and explicit target confirmation.

Every startup imports `ec-data-images.tar`, verifies its image IDs against `release-image-ids.txt` (cross-audited with `release-manifest.json` during packaging), and recreates containers from those verified images.
See `docs/离线包使用说明.md`. Sanitized front-profit templates are under `templates/front-profit/`; portable module, connector, and vertical-solution manifests are under `apps/api/extensions/`.
This package contains no complete source tree, secrets, or real business data.
Project-owned code is distributed under GNU GPL-3.0-only; see LICENSE. Third-party terms are summarized in THIRD_PARTY_NOTICES.md. The corresponding complete source is available at https://github.com/wangge-dev/ec-data-platform-open at the sourceRevision recorded in release-manifest.json. This package never authorizes sharing a user's real business data or secrets.
'@
  Write-Utf8NoBom (Join-Path $distRoot 'README.md') $readme

  Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\release-start.ps1') -Destination (Join-Path $distRoot 'start.ps1') -Force
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\release-start.sh') -Destination (Join-Path $distRoot 'start.sh') -Force
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\release-start.bat') -Destination (Join-Path $distRoot 'start.bat') -Force
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\sha256.ps1') -Destination (Join-Path $distRoot 'sha256.ps1') -Force
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\instance-backup.ps1') -Destination (Join-Path $distRoot 'backup.ps1') -Force
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\instance-restore.ps1') -Destination (Join-Path $distRoot 'restore.ps1') -Force
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\instance-backup.sh') -Destination (Join-Path $distRoot 'backup.sh') -Force
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\instance-restore.sh') -Destination (Join-Path $distRoot 'restore.sh') -Force

  Convert-StagedShellScriptsToUtf8Lf $distRoot

  if ($imageIds.Count -gt 0) {
    $contractLines = @($images | ForEach-Object { $_ + '=' + [string]$imageIds[$_] })
    Write-Utf8NoBom (Join-Path $distRoot 'release-image-ids.txt') ([string]::Join("`n", $contractLines) + "`n")
  }

  $manifest = [ordered]@{
    name = $distName
    createdAt = [DateTime]::UtcNow.ToString(
      "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
      [Globalization.CultureInfo]::InvariantCulture
    )
    sourceRevision = $sourceRevision
    imageSource = $imageSource
    images = $images
    imageIds = $imageIds
    files = @(Get-ReleaseFileRecords $distRoot)
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 5
  Write-Utf8NoBom (Join-Path $distRoot 'release-manifest.json') $manifestJson

  Assert-ReleaseTree $distRoot
  Assert-ReleaseManifest $distRoot
  Compress-Archive -Path $distRoot -DestinationPath $zipTemp -CompressionLevel Optimal
  $expandedRoot = Join-Path $stagingRoot 'expanded'
  Expand-Archive -LiteralPath $zipTemp -DestinationPath $expandedRoot -Force
  $expandedDistRoot = Join-Path $expandedRoot $distName
  Assert-ReleaseTree $expandedDistRoot
  Assert-ReleaseManifest $expandedDistRoot
  $zipHash = (Get-Sha256Hex $zipTemp).ToUpperInvariant()
  $zipBytes = (Get-Item -LiteralPath $zipTemp).Length
  Move-Item -LiteralPath $zipTemp -Destination $zipFinal -Force
}
finally {
  if (-not $PreserveStaging -and (Test-Path -LiteralPath $stagingRoot)) {
    Assert-SafeChildPath $OutputRoot $stagingRoot
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}

Write-Host "Release ZIP: $zipFinal"
Write-Host "Bytes: $zipBytes"
Write-Host "SHA-256: $zipHash"
if ($PreserveStaging) { Write-Host "Staging evidence: $stagingRoot" }
