function Get-Sha256Hex([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw 'SHA-256 input path must not be empty.'
  }

  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSProvider.Name -cne 'FileSystem' -or $item.PSIsContainer) {
    throw "SHA-256 input must be a filesystem file: $Path"
  }

  $stream = [IO.File]::Open(
    $item.FullName,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  $algorithm = $null
  try {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    if ($null -eq $algorithm) {
      throw 'The .NET runtime did not provide SHA-256.'
    }
    $bytes = $algorithm.ComputeHash($stream)
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
  }
  finally {
    if ($null -ne $algorithm) { $algorithm.Dispose() }
    $stream.Dispose()
  }
}
