# EJE guarded release - the operator's side. Release readiness, 25 October 2026.
#
#   Read-only check (changes nothing on the server):
#     powershell -ExecutionPolicy Bypass -File deploy\release\stage-release.ps1 -Sha <full-sha> -CheckOnly
#   The release (ONLY with the owner's separate approval):
#     powershell -ExecutionPolicy Bypass -File deploy\release\stage-release.ps1 -Sha <full-sha>
#   Roll back to the recorded previous release:
#     powershell -ExecutionPolicy Bypass -File deploy\release\stage-release.ps1 -Rollback [-To 4634d5d]
#
# What it verifies BEFORE it connects:
#   - the commit is a full 40-character hash and exists in this repository;
#   - deploy/release/deploy-release.sh is committed and unmodified, so the script
#     that runs on the server is a reviewed one; its SHA-256 is printed.
# Over ONE key-only connection (the same options as stage-ssh.ps1 - key named
# explicitly, public-key only, never a password):
#   - the script is uploaded and its SHA-256 recomputed ON THE SERVER; a mismatch
#     stops before anything runs;
#   - the host must be the one expected; another host stops before anything runs;
#   - the release runs as a DETACHED systemd unit (eje-release-<short>), so a
#     dropped SSH connection cannot kill it half-way through a switch; this
#     follows its journal until it finishes.
# Afterwards, FROM THIS PC: the public health endpoint must report the commit
# the server says it is serving.
#
# All the gates and rollbacks are the server script's (deploy-release.sh); this
# never switches, migrates or rolls back anything itself.
param(
  [string]$Sha = '',
  [switch]$CheckOnly,
  [switch]$Rollback,
  [string]$To = '',
  [string]$SshExe = 'ssh',
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\eje_vps'),
  [string]$Target = 'root@187.77.182.214',
  [string]$ExpectHost = 'srv2000625',
  [string]$HealthUrl = 'https://eje.syncza.co.za/api/health',
  [string]$LogDir = '',
  # Test seams.
  [string]$Repo = '',
  [string]$ProbeScript = ''
)
$ErrorActionPreference = 'Continue'
if (-not $Repo) { $Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
if (-not $LogDir) { $LogDir = $Repo }
$mode = if ($Rollback) { 'rollback' } elseif ($CheckOnly) { 'check' } else { 'release' }
$log = Join-Path $LogDir "stage-release-$mode.log"
$script = Join-Path $Repo 'deploy\release\deploy-release.sh'

$KeyOnly = @(
  '-i', $KeyPath,
  '-o', 'IdentitiesOnly=yes',
  '-o', 'PubkeyAuthentication=yes',
  '-o', 'PreferredAuthentications=publickey',
  '-o', 'PasswordAuthentication=no',
  '-o', 'KbdInteractiveAuthentication=no',
  '-o', 'ConnectTimeout=20',
  '-o', 'ServerAliveInterval=30'
)

Set-Content -Path $log -Value "EJE release stage $(Get-Date -Format o)  mode=$mode sha=$Sha" -Encoding utf8
function Log($text) { Add-Content -Path $log -Value $text -Encoding utf8; Write-Host $text }
function Stop-Stage($why, [int]$code = 1) { Log "`n######## STOPPED ########`n$why"; exit $code }
function Sha256Hex([byte[]]$bytes) {
  -join ([System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
}
function PublicHealth {
  if ($ProbeScript) { return [string](& $ProbeScript health $HealthUrl) }
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri $HealthUrl).Content
  } catch { return "ERROR: $($_.Exception.Message)" }
}

# ---- 1. local verification, before any connection --------------------------------
if (-not $Rollback) {
  if ($Sha -notmatch '^[0-9a-f]{40}$') { Stop-Stage "Give the FULL 40-character commit hash, not '$Sha'. Nothing was contacted." }
  & git -C $Repo cat-file -e "$Sha^{commit}" 2>$null
  if ($LASTEXITCODE -ne 0) { Stop-Stage "Commit $Sha is not in this repository (git fetch first). Nothing was contacted." }
}
if (-not (Test-Path -LiteralPath $KeyPath)) { Stop-Stage "Key file not found: $KeyPath. Nothing was contacted." }
# Tracked AND unmodified: `git diff` alone says nothing about a file git does not track.
& git -C $Repo ls-files --error-unmatch deploy/release/deploy-release.sh *> $null
if ($LASTEXITCODE -ne 0) { Stop-Stage 'deploy/release/deploy-release.sh is not committed - only a committed, reviewed script is uploaded. Nothing was contacted.' }
& git -C $Repo diff --quiet HEAD -- deploy/release/deploy-release.sh 2>$null
if ($LASTEXITCODE -ne 0) { Stop-Stage 'deploy/release/deploy-release.sh has uncommitted changes - only a committed, reviewed script is uploaded. Nothing was contacted.' }

# LF bytes exactly as committed: what the server will hash.
$bytes = [System.IO.File]::ReadAllBytes($script)
$text = [System.Text.Encoding]::UTF8.GetString($bytes) -replace "`r", ''
$bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
$hash = Sha256Hex $bytes
$toolCommit = (& git -C $Repo rev-parse --short HEAD 2>$null)
Log "release script: deploy/release/deploy-release.sh at $toolCommit, sha256 $hash"
Log "key: $KeyPath  (enter its passphrase when ssh asks)"

# ---- 2. one key-only connection: upload, verify hash and host, run ------------------
$ms = New-Object System.IO.MemoryStream
$gz = New-Object System.IO.Compression.GZipStream($ms, [System.IO.Compression.CompressionMode]::Compress)
$gz.Write($bytes, 0, $bytes.Length); $gz.Close()
$b64 = [Convert]::ToBase64String($ms.ToArray())

$short = if ($Sha) { $Sha.Substring(0, 7) } else { '' }
$action = switch ($mode) {
  'check' { "bash /root/eje-ops/deploy-release.sh --check $Sha" }
  'rollback' { "bash /root/eje-ops/deploy-release.sh --rollback $To" }
  'release' {
    # Detached, so a dropped connection cannot kill it mid-switch; then follow it.
    # The start is checked on its own: `a && b & c` would background `a && b`.
    "systemd-run --quiet --unit=eje-release-$short --collect --setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /bin/bash /root/eje-ops/deploy-release.sh --release $Sha || { echo START_FAILED; exit 5; }; " +
    "journalctl -u eje-release-$short -f -o cat --no-pager & follower=`$!; " +
    "while systemctl is-active --quiet eje-release-$short 2>/dev/null; do sleep 3; done; sleep 2; kill `$follower 2>/dev/null; " +
    'echo; bash /root/eje-ops/deploy-release.sh --status'
  }
}
# `cut -c1-64` rather than `cut -d' '`: no quotes to escape through two shells.
$remote = "install -d -m 700 /root/eje-ops && echo $b64 | base64 -d | gzip -dc > /root/eje-ops/deploy-release.sh && chmod 700 /root/eje-ops/deploy-release.sh && " +
  "h=`$(sha256sum < /root/eje-ops/deploy-release.sh | cut -c1-64) && echo REMOTE_SHA256 `$h && echo REMOTE_HOST `$(hostname) && " +
  "if [ `"`$h`" != $hash ]; then echo HASH_MISMATCH; exit 3; fi && " +
  "if [ `"`$(hostname)`" != $ExpectHost ]; then echo HOST_MISMATCH; exit 4; fi && { $action ; } 2>&1"
if ($remote.Length -gt 30000) { Stop-Stage "The command is $($remote.Length) characters, too long for one command line. Nothing was contacted." }

$sshLog = Join-Path $LogDir 'stage-release.client.log'
Remove-Item -LiteralPath $sshLog -ErrorAction SilentlyContinue
Log "`n######## $mode on $Target ########"
$out = & $SshExe @KeyOnly -E $sshLog $Target $remote | Out-String
$code = $LASTEXITCODE
$err = if (Test-Path -LiteralPath $sshLog) { (Get-Content -Raw $sshLog) } else { '' }
Log ($out.TrimEnd() + $(if ($err) { "`n[ssh] " + $err.TrimEnd() } else { '' }) + "`n[exit $code]")

if ($out -match 'HASH_MISMATCH' -or $out -notmatch "REMOTE_SHA256 $hash") { Stop-Stage 'The script on the server does not match the reviewed local copy. Nothing ran.' }
if ($out -match 'HOST_MISMATCH' -or $out -notmatch "REMOTE_HOST $ExpectHost") { Stop-Stage "The server is not $ExpectHost. Nothing ran." }

# ---- 3. the verdict, from the server's own words, then from outside --------------
switch ($mode) {
  'check' {
    if ($out -match 'CHECK PASSED') { Log "`nCHECKED (read only): the server is ready for $short. Nothing was changed."; exit 0 }
    Stop-Stage 'The server check did not pass (above). Nothing was changed.'
  }
  'rollback' {
    if ($out -match 'ROLLED BACK: serving ([0-9a-f]{7})') {
      $back = $Matches[1]; $public = PublicHealth
      Log "public health: $($public.Trim())"
      if ($public -match "`"commit`":`"$back`"" -and $public -match '"database":"reachable"') { Log "`nROLLED BACK to $back - confirmed from outside."; exit 0 }
      Stop-Stage "The server says it rolled back to $back, but the public health endpoint does not confirm it (above)." 2
    }
    Stop-Stage 'The rollback did not complete (above). Read the server output before doing anything.' 2
  }
  'release' {
    if ($out -match "RELEASED: serving $short") {
      $public = PublicHealth
      Log "public health: $($public.Trim())"
      if ($public -match "`"commit`":`"$short`"" -and $public -match '"database":"reachable"') { Log "`nRELEASED $short - confirmed from outside."; exit 0 }
      Stop-Stage "The server reports $short released, but the public health endpoint does not confirm it (above). Read before acting." 2
    }
    if ($out -match 'ROLLBACK NOT VERIFIED') { Stop-Stage 'THE ROLLBACK COULD NOT BE VERIFIED. Do not retry; read the server output and decide by hand.' 2 }
    if ($out -match 'ROLLED BACK: serving') { Stop-Stage 'The new release was unhealthy and was ROLLED BACK automatically (above). Migration 0030 stays applied, which the live release reads.' }
    Stop-Stage 'The release stopped at a gate (above) - see the server output for which one and what it says was changed.'
  }
}
