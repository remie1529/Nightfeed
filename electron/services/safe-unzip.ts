/**
 * Safe Windows .zip extraction using .NET System.IO.Compression.ZipFile.
 * - Passes paths exclusively via environment variables (immune to shell/quote injection).
 * - Enforces canonical path containment on every archive entry (prevents Zip-Slip).
 * - Runs asynchronously so Electron's main thread is never blocked.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

const SAFE_UNZIP_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath = $env:NF_ZIP_PATH
$destDir = [System.IO.Path]::GetFullPath($env:NF_ZIP_DEST)
if (-not $zipPath -or -not (Test-Path -LiteralPath $zipPath)) { throw 'Zip file not found' }
[System.IO.Directory]::CreateDirectory($destDir) | Out-Null
$sep = [System.IO.Path]::DirectorySeparatorChar
$prefix = if ($destDir.EndsWith($sep)) { $destDir } else { $destDir + $sep }
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  foreach ($entry in $archive.Entries) {
    $rel = $entry.FullName -replace '/', $sep
    if (-not $rel) { continue }
    $target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($destDir, $rel))
    if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw ('Zip entry escapes destination: ' + $entry.FullName)
    }
    if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\\')) {
      [System.IO.Directory]::CreateDirectory($target) | Out-Null
      continue
    }
    $parent = [System.IO.Path]::GetDirectoryName($target)
    if ($parent) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
  }
} finally {
  $archive.Dispose()
}
`.trim();

export function extractZipSafely(
  zipPath: string,
  destDir: string,
  timeoutMs = 180_000
): Promise<void> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Zip extraction is only supported on Windows'));
  }
  const absZip = path.resolve(zipPath);
  const absDest = path.resolve(destDir);
  if (!fs.existsSync(absZip)) {
    return Promise.reject(new Error('Zip file not found'));
  }
  fs.mkdirSync(absDest, { recursive: true });
  return new Promise<void>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SAFE_UNZIP_PS],
      {
        windowsHide: true,
        timeout: timeoutMs,
        env: {
          ...process.env,
          NF_ZIP_PATH: absZip,
          NF_ZIP_DEST: absDest,
        },
      },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || 'Zip extraction failed').trim();
          reject(new Error(detail.slice(0, 400)));
          return;
        }
        resolve();
      }
    );
  });
}
