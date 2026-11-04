# PULL EJE'S ENCRYPTED BACKUPS OFF THE SERVER - onto this computer. BACKUP-1 (4 November 2026).
#
# The interim off-server destination until an object-storage bucket is configured
# for EJE_BACKUP_OFFSITE_RCLONE (docs/vps-backups.md section 5): THIS computer, which is a
# different machine in a different place from the VPS and already reaches it with
# the release key. It copies only what the server already encrypted - the dump and
# the documents stay AES-256-GCM ciphertext; the key never leaves the server - and:
#
#   1. lists the server's backups (read only) and picks the newest -Keep of them;
#   2. copies each one not already here into .incoming\<name> (scp, key only);
#   3. VERIFIES it here, independently: every artefact's size and SHA-256 against its
#      own manifest.json, and that the dump is ciphertext, not a readable pg_dump;
#   4. only then moves it into place - a copy that fails is deleted from .incoming
#      and is never counted as a backup;
#   5. keeps the newest -Keep verified copies here (only folders this script made);
#   6. writes last-pull.json and pull-offsite.log beside them, and exits 1 on any
#      failure, so a scheduled run that failed shows as failed.
#
#   powershell -ExecutionPolicy Bypass -File deploy\backup\pull-offsite.ps1
#
# It never writes to the server, never reads the key, and never deletes a backup
# on the server.
param(
  [string]$Target = 'root@187.77.182.214',
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\eje_vps'),
  [string]$SshExe = 'C:\Windows\System32\OpenSSH\ssh.exe',
  [string]$ScpExe = 'C:\Windows\System32\OpenSSH\scp.exe',
  [string]$Destination = (Join-Path $env:USERPROFILE 'EJE-offsite-backups'),
  [string]$RemoteRoot = '/var/backups/eje',
  [int]$Keep = 14
)
$ErrorActionPreference = 'Stop'
$pattern = '^eje-eje_production-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$'
New-Item -ItemType Directory -Force $Destination | Out-Null
$logFile = Join-Path $Destination 'pull-offsite.log'
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$pulled = @(); $failures = @()
function Log([string]$line) { $stamped = "$((Get-Date).ToUniversalTime().ToString('o')) $line"; Write-Output $stamped; Add-Content -Path $logFile -Value $stamped -Encoding utf8 }
$opts = @('-i', $KeyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30')

function Verify-Copy([string]$dir) {
  $manifestPath = Join-Path $dir 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { return 'no manifest.json' }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if ($null -eq $manifest.artefacts -or @($manifest.artefacts).Count -lt 2) { return 'the manifest lists no artefacts' }
  foreach ($artefact in $manifest.artefacts) {
    $file = Join-Path $dir $artefact.name
    if (-not (Test-Path -LiteralPath $file)) { return "$($artefact.name) is missing" }
    $size = (Get-Item -LiteralPath $file).Length
    if ($size -ne [int64]$artefact.bytes) { return "$($artefact.name) is $size bytes, the manifest says $($artefact.bytes)" }
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $artefact.sha256) { return "$($artefact.name) SHA-256 does not match the manifest" }
  }
  # Encrypted, never plaintext: a pg_dump custom archive starts with PGDMP.
  $head = [System.IO.File]::ReadAllBytes((Join-Path $dir 'database.dump.enc'))[0..4]
  if ([System.Text.Encoding]::ASCII.GetString($head) -eq 'PGDMP') { return 'database.dump.enc is a plaintext dump' }
  return $null
}

try {
  $listing = & $SshExe @opts $Target "ls -1 $RemoteRoot" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "listing the server's backups failed: $listing" }
  $remote = @($listing | Where-Object { $_ -match $pattern } | Sort-Object -Descending | Select-Object -First $Keep)
  if ($remote.Count -eq 0) { throw "the server lists no backups in $RemoteRoot" }
  $incoming = Join-Path $Destination '.incoming'
  foreach ($name in $remote) {
    $final = Join-Path $Destination $name
    if (Test-Path -LiteralPath $final) {
      $problem = Verify-Copy $final
      if ($null -eq $problem) { continue }
      Log "re-pulling ${name}: the copy here no longer verifies ($problem)"
      Remove-Item -Recurse -Force -LiteralPath $final
    }
    Remove-Item -Recurse -Force -LiteralPath $incoming -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $incoming | Out-Null
    & $ScpExe @opts -r -p "${Target}:$RemoteRoot/$name" $incoming 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $failures += "${name}: the copy failed"; Log "FAILED ${name}: scp exit $LASTEXITCODE"; continue }
    $problem = Verify-Copy (Join-Path $incoming $name)
    if ($null -ne $problem) { $failures += "${name}: $problem"; Log "FAILED ${name}: $problem - not kept"; continue }
    Move-Item -LiteralPath (Join-Path $incoming $name) -Destination $final
    $pulled += $name
    Log "pulled and verified $name"
  }
  Remove-Item -Recurse -Force -LiteralPath $incoming -ErrorAction SilentlyContinue
  # Retention: the newest -Keep verified copies; only folders named as this script names them.
  $local = @(Get-ChildItem -Directory -LiteralPath $Destination | Where-Object { $_.Name -match $pattern } | Sort-Object Name -Descending)
  foreach ($old in ($local | Select-Object -Skip $Keep)) { Remove-Item -Recurse -Force -LiteralPath $old.FullName; Log "retention: removed the local copy $($old.Name)" }
} catch {
  $failures += $_.Exception.Message
  Log "FAILED: $($_.Exception.Message)"
}

$held = @(Get-ChildItem -Directory -LiteralPath $Destination | Where-Object { $_.Name -match $pattern } | Sort-Object Name -Descending | ForEach-Object { $_.Name })
$status = [ordered]@{
  outcome = $(if ($failures.Count -eq 0) { 'ok' } else { 'failed' })
  startedAt = $startedAt
  finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  pulled = $pulled
  failures = $failures
  newestHeld = $(if ($held.Count -gt 0) { $held[0] } else { $null })
  heldCount = $held.Count
}
$status | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $Destination 'last-pull.json') -Encoding utf8
Log "outcome $($status.outcome): pulled $($pulled.Count), holding $($held.Count), newest $($status.newestHeld)"
if ($failures.Count -gt 0) { exit 1 }
exit 0
