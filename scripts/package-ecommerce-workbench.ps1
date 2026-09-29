[CmdletBinding()]
param(
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputPath) {
  $OutputPath = Join-Path $RepoRoot 'release/ecommerce-workbench-v1.zip'
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if ([IO.Path]::GetExtension($OutputPath) -ine '.zip') {
  throw 'OutputPath 必须是 .zip 文件。'
}

$templateRoot = Join-Path $RepoRoot 'templates/ecommerce-workbench'
$sampleRoot = Join-Path $templateRoot 'samples'
$builder = Join-Path $RepoRoot 'apps/api/scripts/ecommerce-intake/build-workbench-assets.ts'
$sampleVerifier = Join-Path $RepoRoot 'apps/api/scripts/ecommerce-intake/verify-workbench-share-samples.mjs'
$tsxLauncher = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'tsx.cmd' } else { 'tsx' }
$localTsx = Join-Path $RepoRoot "apps/api/node_modules/.bin/$tsxLauncher"
$expectedSamples = @(
  'pdd_ads_account_day.xlsx',
  'pdd_ads_product_period.xlsx',
  'pdd_order_item.xlsx',
  'taobao_category_month.xlsx',
  'taobao_price_band_day.xlsx',
  'taobao_terminal_day.xlsx',
  'taobao_trade_day.xlsx'
)
$expectedPayload = @(
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'solution/ecommerce-operations-workbench.solution.json',
  'solution/ecommerce-workbench-board.blueprint.json',
  'solution/package-manifest.json'
) + ($expectedSamples | ForEach-Object { "samples/$_" })

foreach ($required in @((Join-Path $templateRoot 'README.md'), (Join-Path $RepoRoot 'LICENSE'), (Join-Path $RepoRoot 'THIRD_PARTY_NOTICES.md'), $builder, $sampleVerifier, $localTsx)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "缺少打包依赖：$required"
  }
}
$actualSamples = @(Get-ChildItem -LiteralPath $sampleRoot -File | Select-Object -ExpandProperty Name | Sort-Object)
if ([string]::Join("`n", $actualSamples) -cne [string]::Join("`n", ($expectedSamples | Sort-Object))) {
  throw "样例目录必须且只能包含七个约定工作簿；实际：$($actualSamples -join ', ')"
}
$sampleVerificationJson = & node $sampleVerifier $sampleRoot
if ($LASTEXITCODE -ne 0) { throw '固定合成样例语义检查失败。' }
$sampleVerification = $sampleVerificationJson | ConvertFrom-Json

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd(
  [IO.Path]::DirectorySeparatorChar,
  [IO.Path]::AltDirectorySeparatorChar
)
$tempRoot = Join-Path $tempBase ("ec-workbench-package-" + [Guid]::NewGuid().ToString('N'))
$payloadRoot = Join-Path $tempRoot 'ecommerce-workbench-v1'
$solutionRoot = Join-Path $payloadRoot 'solution'
$payloadSamples = Join-Path $payloadRoot 'samples'
$temporaryArchive = $null

function Read-ZipText {
  param([Parameter(Mandatory)][string]$ArchivePath)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $builder = [Text.StringBuilder]::new()
    foreach ($entry in $archive.Entries) {
      if (-not $entry.FullName.EndsWith('.xml', [StringComparison]::OrdinalIgnoreCase) -and
          -not $entry.FullName.EndsWith('.rels', [StringComparison]::OrdinalIgnoreCase)) {
        continue
      }
      $reader = [IO.StreamReader]::new($entry.Open())
      try { [void]$builder.AppendLine($reader.ReadToEnd()) }
      finally { $reader.Dispose() }
    }
    return $builder.ToString()
  }
  finally { $archive.Dispose() }
}

New-Item -ItemType Directory -Path $solutionRoot -Force | Out-Null
New-Item -ItemType Directory -Path $payloadSamples -Force | Out-Null
try {
  $null = & $localTsx $builder --output $solutionRoot
  if ($LASTEXITCODE -ne 0) { throw '方案 JSON 生成失败。' }
  Copy-Item -LiteralPath (Join-Path $templateRoot 'README.md') -Destination $payloadRoot
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'LICENSE') -Destination $payloadRoot
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'THIRD_PARTY_NOTICES.md') -Destination $payloadRoot
  foreach ($sample in $expectedSamples) {
    Copy-Item -LiteralPath (Join-Path $sampleRoot $sample) -Destination $payloadSamples
  }

  $actualPayload = @(Get-ChildItem -LiteralPath $payloadRoot -File -Recurse | ForEach-Object {
    $_.FullName.Substring($payloadRoot.Length + 1).Replace('\', '/')
  } | Sort-Object)
  if ([string]::Join("`n", $actualPayload) -cne [string]::Join("`n", ($expectedPayload | Sort-Object))) {
    throw "分享包文件清单异常：$($actualPayload -join ', ')"
  }

  $manifest = Get-Content -LiteralPath (Join-Path $solutionRoot 'package-manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.containsBusinessData -ne $false -or $manifest.containsSecrets -ne $false) {
    throw 'package-manifest 必须明确声明不含业务数据和密钥。'
  }

  $forbidden = '(?i)BaiduNetdiskDownload|xwechat|数据留档|23&24前台利润|D:\\Work|C:\\Users|Administrator'
  $textPayload = @(
    Get-Content -LiteralPath (Join-Path $payloadRoot 'README.md') -Raw
    Get-Content -LiteralPath (Join-Path $solutionRoot 'ecommerce-operations-workbench.solution.json') -Raw
    Get-Content -LiteralPath (Join-Path $solutionRoot 'ecommerce-workbench-board.blueprint.json') -Raw
    Get-Content -LiteralPath (Join-Path $solutionRoot 'package-manifest.json') -Raw
  ) -join "`n"
  if ($textPayload -match $forbidden) { throw '文本文件包含本机路径或已知私有来源标记。' }

  foreach ($sample in $expectedSamples) {
    $xlsxText = Read-ZipText -ArchivePath (Join-Path $payloadSamples $sample)
    if ($xlsxText -match $forbidden) { throw "$sample 包含本机路径或已知私有来源标记。" }
    if ($xlsxText -notmatch 'SAMPLE_BATCH_20991231' -or
        $xlsxText -notmatch '2099' -or
        $xlsxText -notmatch '示例') {
      throw "$sample 缺少固定合成数据标记。"
    }
  }

  $outputParent = Split-Path -Parent $OutputPath
  New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
  $temporaryArchive = Join-Path $outputParent (
    '.' + [IO.Path]::GetFileNameWithoutExtension($OutputPath) + '.' +
    [Guid]::NewGuid().ToString('N') + '.tmp.zip'
  )
  Compress-Archive -LiteralPath $payloadRoot -DestinationPath $temporaryArchive -CompressionLevel Optimal
  [IO.File]::Move($temporaryArchive, $OutputPath, $true)
  $temporaryArchive = $null
  [PSCustomObject]@{
    output = $OutputPath
    files = $actualPayload.Count
    modules = 7
    businessEntries = 4
    sampleRows = $sampleVerification.rows
    containsBusinessData = $false
    containsSecrets = $false
  } | ConvertTo-Json
}
finally {
  if ($temporaryArchive) {
    $resolvedArchiveTemp = [IO.Path]::GetFullPath($temporaryArchive)
    $resolvedOutputParent = [IO.Path]::GetFullPath((Split-Path -Parent $OutputPath)).TrimEnd(
      [IO.Path]::DirectorySeparatorChar,
      [IO.Path]::AltDirectorySeparatorChar
    )
    $archivePrefix = $resolvedOutputParent + [IO.Path]::DirectorySeparatorChar + '.' +
      [IO.Path]::GetFileNameWithoutExtension($OutputPath) + '.'
    if ($resolvedArchiveTemp.StartsWith($archivePrefix, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedArchiveTemp)) {
      [IO.File]::Delete($resolvedArchiveTemp)
    }
  }
  $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
  $safePrefix = $tempBase + [IO.Path]::DirectorySeparatorChar + 'ec-workbench-package-'
  if ($resolvedTemp.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $resolvedTemp)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
  }
}
