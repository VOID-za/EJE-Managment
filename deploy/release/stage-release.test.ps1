# Offline tests for stage-release.ps1: every local refusal, the hash and host
# checks, each server verdict, and the outside confirmation. Nothing is contacted:
# ssh is stage-release.fake-ssh.ps1 and the public health check is a stub.
#   powershell -ExecutionPolicy Bypass -File deploy\release\stage-release.test.ps1
$stage = Join-Path $PSScriptRoot 'stage-release.ps1'
$fake = Join-Path $PSScriptRoot 'stage-release.fake-ssh.ps1'
$work = Join-Path ([IO.Path]::GetTempPath()) ('eje-stage-release-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
$env:FAKE_DIR = $work
$pass = 0; $fail = 0
function Check($name, $cond) { if ($cond) { $script:pass++; Write-Host "ok   $name" } else { $script:fail++; Write-Host "FAIL $name" } }

# A throwaway repository holding a COMMITTED copy of the release script.
$repo = Join-Path $work 'repo'
New-Item -ItemType Directory -Path (Join-Path $repo 'deploy\release') | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'deploy-release.sh') (Join-Path $repo 'deploy\release\deploy-release.sh')
& git -C $repo init -q 2>$null; & git -C $repo -c user.name=t -c user.email=t@t add -A 2>$null
& git -C $repo -c user.name=t -c user.email=t@t commit -q -m fixture 2>$null
$sha = (& git -C $repo rev-parse HEAD).Trim()
$short = $sha.Substring(0, 7)
$key = Join-Path $work 'a key with spaces'; Set-Content $key 'not a key'
# Public health: answers for whatever commit FAKE_PUBLIC names.
$probe = Join-Path $work 'probe.ps1'
Set-Content $probe -Value 'param($k,$u) "{""status"":""ok"",""database"":""reachable"",""build"":{""commit"":""$env:FAKE_PUBLIC""}}"'

# A HASHTABLE, not an array: splatting an array passes '-Sha' as a positional
# string, and only hashtable splatting binds names to parameters and switches.
function Run([hashtable]$extra, $scenario = 'ok', $public = '') {
  Remove-Item (Join-Path $work 'calls.jsonl') -ErrorAction SilentlyContinue
  $env:FAKE_RELEASE = $scenario; $env:FAKE_PUBLIC = $public
  & $stage @extra -SshExe $fake -KeyPath $key -Repo $repo -LogDir $work -ProbeScript $probe *> $null
  $code = $LASTEXITCODE
  $calls = @(Get-Content (Join-Path $work 'calls.jsonl') -ErrorAction SilentlyContinue | ForEach-Object { $_ | ConvertFrom-Json })
  $mode = if ($extra.ContainsKey('Rollback')) { 'rollback' } elseif ($extra.ContainsKey('CheckOnly')) { 'check' } else { 'release' }
  return @{ Code = $code; Calls = $calls; Log = (Get-Content -Raw (Join-Path $work "stage-release-$mode.log")) }
}
# The release script's sha256 as committed (LF), which the fake recomputes.
$text = ([IO.File]::ReadAllText((Join-Path $repo 'deploy\release\deploy-release.sh'))) -replace "`r", ''
$hash = -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($text)) | ForEach-Object { $_.ToString('x2') })

# ---- refusals before any connection ---------------------------------------------
$r = Run @{ Sha = 'de0d9b6'; CheckOnly = $true }
Check 'a short hash is refused, nothing contacted' ($r.Code -eq 1 -and $r.Calls.Count -eq 0 -and $r.Log -match 'FULL 40-character')
$r = Run @{ Sha = ('f' * 40); CheckOnly = $true }
Check 'a commit not in the repository is refused, nothing contacted' ($r.Code -eq 1 -and $r.Calls.Count -eq 0 -and $r.Log -match 'not in this repository')
Add-Content (Join-Path $repo 'deploy\release\deploy-release.sh') '# an unreviewed edit'
$r = Run @{ Sha = $sha; CheckOnly = $true }
Check 'an uncommitted change to the release script is refused, nothing contacted' ($r.Code -eq 1 -and $r.Calls.Count -eq 0 -and $r.Log -match 'uncommitted changes')
& git -C $repo checkout -q -- deploy/release/deploy-release.sh 2>$null

# ---- the connection itself --------------------------------------------------------
$r = Run @{ Sha = $sha; CheckOnly = $true }
Check 'check: ONE key-only connection, the key path with spaces intact' ($r.Calls.Count -eq 1 -and $r.Calls[0].key -eq $key -and $r.Calls[0].opts -contains 'PasswordAuthentication=no' -and $r.Calls[0].opts -contains 'IdentitiesOnly=yes')
Check 'check: never NumberOfPasswordPrompts=0 (it would stop the passphrase prompt)' (@($r.Calls[0].opts | Where-Object { $_ -match '^NumberOfPasswordPrompts' }).Count -eq 0)
Check 'check: the server recomputes the reviewed hash, and the check passes' ($r.Code -eq 0 -and $r.Log -match "sha256 $hash" -and $r.Log -match 'CHECKED \(read only\)')
Check 'the command fits on one command line' ($r.Calls[0].len -lt 30000)
$r = Run @{ Sha = $sha; CheckOnly = $true } 'checkfail'
Check 'a failed server check is reported, exit 1' ($r.Code -eq 1 -and $r.Log -match 'did not pass')
$r = Run @{ Sha = $sha } 'hash'
Check 'a hash mismatch on the server stops before anything runs' ($r.Code -eq 1 -and $r.Log -match 'does not match the reviewed local copy')
$r = Run @{ Sha = $sha } 'host'
Check 'the wrong host stops before anything runs' ($r.Code -eq 1 -and $r.Log -match 'is not srv2000625')

# ---- the release: detached, followed, verified from outside ------------------------
$r = Run @{ Sha = $sha } 'ok' $short
Check 'release: runs as a DETACHED unit, the start checked on its own' ($r.Calls[0].cmd -match "systemd-run --quiet --unit=eje-release-$short --collect" -and $r.Calls[0].cmd -match '\|\| \{ echo START_FAILED; exit 5; \}' -and $r.Calls[0].cmd -notmatch '&& journalctl')
Check 'release: RELEASED, confirmed from outside, exit 0' ($r.Code -eq 0 -and $r.Log -match "RELEASED $short - confirmed from outside")
$r = Run @{ Sha = $sha } 'ok' '4634d5d'
Check 'release: the server says released but the public endpoint disagrees -> exit 2, not success' ($r.Code -eq 2 -and $r.Log -match 'does not confirm')
$r = Run @{ Sha = $sha } 'stopped'
Check 'release stopped at a gate: exit 1, reported' ($r.Code -eq 1 -and $r.Log -match 'stopped at a gate')
$r = Run @{ Sha = $sha } 'autorollback'
Check 'release rolled back automatically: exit 1, and says the migrations stay' ($r.Code -eq 1 -and $r.Log -match 'ROLLED BACK automatically' -and $r.Log -match 'migrations it applied stay applied')
$r = Run @{ Sha = $sha } 'notverified'
Check 'rollback NOT verified: exit 2, and "do not retry"' ($r.Code -eq 2 -and $r.Log -match 'Do not retry')
$r = Run @{ Sha = $sha } 'startfail'
Check 'the unit failing to start is not mistaken for success' ($r.Code -eq 1 -and $r.Log -notmatch 'RELEASED')

# ---- the expected migrations -----------------------------------------------------------
$r = Run @{ Sha = $sha } 'ok' $short
Check 'by default no EXPECT_PENDING is sent: the server script''s own list (0030, 0031) applies' ($r.Calls[0].cmd -notmatch 'EXPECT_PENDING')
$r = Run @{ Sha = $sha; ExpectPending = '0031_test_repair_date_received' } 'ok' $short
Check '-ExpectPending reaches the detached release unit as its environment' ($r.Code -eq 0 -and $r.Calls[0].cmd -match '--setenv=EXPECT_PENDING=0031_test_repair_date_received /bin/bash /root/eje-ops/deploy-release.sh --release')
$r = Run @{ Sha = $sha; CheckOnly = $true; ExpectPending = '0030_library_page_coverage_unknown,0031_test_repair_date_received' }
Check '-ExpectPending reaches the read-only check too' ($r.Code -eq 0 -and $r.Calls[0].cmd -match 'EXPECT_PENDING=0030_library_page_coverage_unknown,0031_test_repair_date_received bash /root/eje-ops/deploy-release.sh --check')
foreach ($bad in @('0031_test_repair_date_received,0030_library_page_coverage_unknown', '0030_a,0030_a', 'library_page_coverage_unknown', '0030_a, 0031_b', '0030_A')) {
  $r = Run @{ Sha = $sha; ExpectPending = $bad }
  Check "a malformed -ExpectPending ('$bad') is refused, nothing contacted" ($r.Code -eq 1 -and $r.Calls.Count -eq 0 -and $r.Log -match '-ExpectPending')
}

# ---- rollback -------------------------------------------------------------------------
$r = Run @{ Rollback = $true } 'ok' '4634d5d'
Check 'rollback: confirmed from outside, exit 0' ($r.Code -eq 0 -and $r.Log -match 'ROLLED BACK to 4634d5d - confirmed from outside')
$r = Run @{ Rollback = $true } 'ok' $short
Check 'rollback the public endpoint does not confirm -> exit 2' ($r.Code -eq 2 -and $r.Log -match 'does not confirm')

Remove-Item -Recurse -Force $work
Write-Host "`n$pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
