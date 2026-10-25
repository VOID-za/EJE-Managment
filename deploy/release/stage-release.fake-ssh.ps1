# Fake ssh for stage-release.test.ps1. Records the call; plays the server.
# FAKE_RELEASE: ok | stopped | autorollback | notverified | checkfail | hash | host | startfail
$calls = Join-Path $env:FAKE_DIR 'calls.jsonl'
$scenario = $env:FAKE_RELEASE
$opts = @(); $key = $null; $errFile = $null; $rest = @()
for ($i = 0; $i -lt $args.Count; $i++) {
  switch ($args[$i]) {
    '-i' { $key = $args[++$i] }
    '-o' { $opts += $args[++$i] }
    '-E' { $errFile = $args[++$i] }
    default { $rest += $args[$i] }
  }
}
$cmd = ($rest | Select-Object -Skip 1) -join ' '
[pscustomobject]@{ key = $key; opts = $opts; cmd = $cmd; len = $cmd.Length } | ConvertTo-Json -Compress |
  Add-Content -Path $calls -Encoding utf8
if (-not $key -or $opts -contains 'NumberOfPasswordPrompts=0' -or $opts -notcontains 'PasswordAuthentication=no') {
  Set-Content -Path $errFile -Value 'Permission denied (publickey).'; exit 255
}

# Decode what was uploaded, and hash it as the server would.
$b64 = [regex]::Match($cmd, 'echo ([A-Za-z0-9+/=]+) \| base64 -d \| gzip -dc').Groups[1].Value
$gz = New-Object System.IO.Compression.GZipStream((New-Object System.IO.MemoryStream(,[Convert]::FromBase64String($b64))), [System.IO.Compression.CompressionMode]::Decompress)
$buffer = New-Object System.IO.MemoryStream; $gz.CopyTo($buffer)
$hash = -join ([System.Security.Cryptography.SHA256]::Create().ComputeHash($buffer.ToArray()) | ForEach-Object { $_.ToString('x2') })
$expected = [regex]::Match($cmd, 'if \[ "\$h" != ([0-9a-f]{64}) \]').Groups[1].Value
if ($scenario -eq 'hash') { $hash = '0' * 64 }
"REMOTE_SHA256 $hash"
$hostName = if ($scenario -eq 'host') { 'some-other-host' } else { 'srv2000625' }
"REMOTE_HOST $hostName"
if ($hash -ne $expected) { 'HASH_MISMATCH'; exit 3 }
if ($hostName -ne 'srv2000625') { 'HOST_MISMATCH'; exit 4 }

if ($cmd -match '--check ') {
  if ($scenario -eq 'checkfail') { 'PROBLEM: 100 MB free'; 'CHECK FAILED (above) - read only, nothing was changed.'; exit 1 }
  'CHECK PASSED - read only, nothing was changed.'; exit 0
}
if ($cmd -match '--rollback') { 'THE DATABASE IS NOT TOUCHED.'; 'ROLLED BACK: serving 4634d5d, healthy, database reachable.'; exit 0 }
if ($cmd -match '--release ') {
  if ($scenario -eq 'startfail') { 'START_FAILED'; exit 5 }
  switch ($scenario) {
    'stopped' { 'STOPPED: the restore test failed for /var/backups/eje/x. Nothing was changed.' }
    'autorollback' { 'AUTOMATIC ROLLBACK to /opt/eje/releases/4634d5d'; 'ROLLED BACK: serving 4634d5d, healthy, database reachable.' }
    'notverified' { 'ROLLBACK NOT VERIFIED: 4634d5d is linked but not proven healthy.' }
    default {
      # The commit the release was asked for — the server names what it serves.
      $asked = [regex]::Match($cmd, '--release ([0-9a-f]{40})').Groups[1].Value.Substring(0, 7)
      "RELEASED: serving $asked, healthy, database reachable."
    }
  }
  'serving:  /opt/eje/releases/...'
  exit 0
}
'unexpected command'; exit 99
