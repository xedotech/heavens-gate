param(
  [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) { throw "Archive already exists: $destinationPath" }
$excludedDirectories = @('node_modules', '.git', 'artifacts', 'work', '${game}', 'dist', '.next', '.vinext', '.wrangler', '.vite', '.cache', 'coverage')
$pending = [Collections.Generic.Queue[IO.DirectoryInfo]]::new()
$pending.Enqueue([IO.DirectoryInfo]::new($projectRoot))
$files = [Collections.Generic.List[IO.FileInfo]]::new()
while ($pending.Count -gt 0) {
  foreach ($entry in $pending.Dequeue().EnumerateFileSystemInfos()) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    if ($entry -is [IO.DirectoryInfo]) {
      if ($entry.Name -notin $excludedDirectories) { $pending.Enqueue($entry) }
    } elseif (($entry.Name -notlike '.env*' -or $entry.Name -eq '.env.example') -and $entry.Name -notlike '.dev.vars*' -and $entry.Extension -notin @('.log', '.tsbuildinfo', '.pem', '.key', '.pfx', '.zip')) {
      $files.Add($entry)
    }
  }
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archiveStream = [IO.File]::Open($destinationPath, [IO.FileMode]::CreateNew)
$archive = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in ($files | Sort-Object FullName)) {
    $relative = [IO.Path]::GetRelativePath($projectRoot, $file.FullName).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, "heavens-gate/$relative", [IO.Compression.CompressionLevel]::Fastest) | Out-Null
  }
} finally {
  $archive.Dispose()
  $archiveStream.Dispose()
}
$check = [IO.Compression.ZipFile]::OpenRead($destinationPath)
try {
  $entries = @($check.Entries.FullName)
  foreach ($required in @('README.md', 'package.json', 'package-lock.json', 'app/game/engine.ts', 'public/assets/characters/manifest.json', 'public/assets/environment/manifest.json')) {
    if ("heavens-gate/$required" -notin $entries) { throw "Missing archive entry: $required" }
  }
  if ($entries.Count -ne $files.Count) { throw 'Archive entry count differs from the source inventory' }
  [pscustomobject]@{ Path = $destinationPath; Files = $entries.Count; Bytes = (Get-Item -LiteralPath $destinationPath).Length; SHA256 = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash } | ConvertTo-Json
} finally { $check.Dispose() }
