#!/bin/bash
# Tests for harden-sshd.sh against stub commands — no root, no sshd, no network.
#   bash deploy/ssh/harden-sshd.test.sh
# Each case gets a fresh sandbox: a drop-in dir, an authorized_keys file, and
# stubs on PATH that model sshd (config from the drop-in's presence), the live
# daemon (what the local probe is refused with), the revert timer, and the journal.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/harden-sshd.sh"
PASS=0; FAIL=0

sandbox() {
  T=$(mktemp -d); mkdir -p "$T/bin" "$T/d"
  : > "$T/calls"
  echo 'ssh-ed25519 AAAATEST owner' > "$T/keys"
  NOW=$(date -u +%s)
  # The session that runs --check/--apply logged in a minute ago, with a key.
  echo "$((NOW-60)).000000 srv sshd[1]: Accepted publickey for root from 198.51.100.7 port 50000 ssh2: ED25519" > "$T/journal"
  stub() { printf '#!/bin/bash\n%s\n' "$2" > "$T/bin/$1"; chmod +x "$T/bin/$1"; }
  stub id 'echo 0'
  stub logger 'echo "logger $*" >> "$T/calls"'
  stub sleep ':'
  stub sshd 'if [ "$1" = -t ]; then [ -e "$T/sshd_t_fails" ] && exit 1; exit 0; fi
if [ -e "$T/d/10-eje-hardening.conf" ]; then printf "permitrootlogin without-password\npasswordauthentication no\nkbdinteractiveauthentication no\nmaxauthtries 3\npubkeyauthentication yes\n"
else printf "permitrootlogin yes\npasswordauthentication yes\nkbdinteractiveauthentication no\nmaxauthtries 6\npubkeyauthentication yes\n"; fi'
  # The LIVE daemon: what it offers changes only on reload (models "files changed, not reloaded").
  stub ssh 'echo "ssh $*" >> "$T/calls"; methods=$(cat "$T/live" 2>/dev/null || echo publickey,password); echo "root@127.0.0.1: Permission denied (${methods})."; exit 255'
  stub journalctl 'cat "$T/journal"'
  stub systemd-run 'echo "systemd-run $*" >> "$T/calls"; [ -e "$T/arm_fails" ] && exit 1; touch "$T/timer"'
  stub systemctl 'echo "systemctl $*" >> "$T/calls"
case "$1" in
  is-active) [ -e "$T/timer" ];;
  stop) rm -f "$T/timer";;
  reload) if [ -e "$T/reload_ignored" ]; then :; elif [ -e "$T/d/10-eje-hardening.conf" ]; then echo publickey > "$T/live"; else echo publickey,password > "$T/live"; fi;;
  list-timers) echo "NEXT LEFT"; echo "Fri 2026-10-24 20:15:00 UTC 14min left";;
  *) :;;
esac'
  export T
}
run() { # $1=mode ; env SSH_CONNECTION may be set by the caller
  PATH="$T/bin:$PATH" SSHD_DROPIN_DIR="$T/d" AUTH_KEYS="$T/keys" ARMED_FILE="$T/armed" REVERT_SECONDS=900 bash "$SCRIPT" "$1" > "$T/out" 2>&1
  echo $?
}
KEY_SESSION='198.51.100.7 50000 203.0.113.1 22'
PW_SESSION='198.51.100.7 50999 203.0.113.1 22'
NEW_KEY_SESSION='198.51.100.7 50001 203.0.113.1 22'
# A NEW key login, made after --apply armed the revert.
new_login() { echo "$(( $(date -u +%s) + 5 )).000000 srv sshd[2]: Accepted publickey for root from 198.51.100.7 port 50001 ssh2: ED25519" >> "$T/journal"; }
ok() { PASS=$((PASS+1)); printf 'ok   %s\n' "$1"; }
no() { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$1"; sed 's/^/     | /' "$T/out"; }
expect() { # $1=name $2=expected-exit $3=actual-exit $4=grep-pattern-in-output (optional)
  if [ "$2" = "$3" ] && { [ -z "${4:-}" ] || grep -qE "$4" "$T/out"; }; then ok "$1"; else no "$1 (exit $3, wanted $2${4:+, output /$4/})"; fi
}

# 1. --check refuses with no authorized key
sandbox; : > "$T/keys"
expect "check refuses without an authorized key" 1 "$(SSH_CONNECTION=$KEY_SESSION run --check)" 'no authorized key'

# 2. --check refuses when THIS session logged in with a password
sandbox
expect "check refuses from a password session" 1 "$(SSH_CONNECTION=$PW_SESSION run --check)" 'did not log in with a key'

# 3. --check passes from a key session, and changes nothing
sandbox
rc=$(SSH_CONNECTION=$KEY_SESSION run --check)
expect "check passes from a key session" 0 "$rc" 'CHECK ONLY'
[ ! -e "$T/d/10-eje-hardening.conf" ] && [ ! -e "$T/timer" ] && ok "check changes nothing" || no "check changes nothing"

# 4. --apply: drop-in written, revert ARMED BEFORE the reload, live daemon verified
sandbox
rc=$(SSH_CONNECTION=$KEY_SESSION run --apply)
expect "apply succeeds and reports the live daemon" 0 "$rc" 'live daemon now offers only: publickey'
[ -e "$T/d/10-eje-hardening.conf" ] && ok "apply writes the drop-in" || no "apply writes the drop-in"
arm=$(grep -n '^systemd-run' "$T/calls" | head -1 | cut -d: -f1); rel=$(grep -n '^systemctl reload' "$T/calls" | head -1 | cut -d: -f1)
[ -n "$arm" ] && [ -n "$rel" ] && [ "$arm" -lt "$rel" ] && ok "auto-revert is armed before the reload" || no "auto-revert is armed before the reload"
grep -q -- '--on-active=900' "$T/calls" && ok "window is 900s" || no "window is 900s"
grep -q 'logger -t eje-sshd-revert' "$T/calls" && ok "the revert logs to the journal" || no "the revert logs to the journal"
grep -qiE 'before [0-9:]+ UTC|in 900s' "$T/out" && ok "apply prints the deadline" || no "apply prints the deadline"

# 5. --apply backs out if the live daemon STILL offers passwords after reload
sandbox; touch "$T/reload_ignored"
rc=$(SSH_CONNECTION=$KEY_SESSION run --apply)
expect "apply backs out when the live daemon still offers passwords" 1 "$rc" 'STILL offers passwords'
[ ! -e "$T/d/10-eje-hardening.conf" ] && [ ! -e "$T/timer" ] && ok "...drop-in removed and timer stopped" || no "...drop-in removed and timer stopped"

# 6. --apply: sshd -t failure leaves nothing behind and arms nothing
sandbox; touch "$T/sshd_t_fails"
expect "apply refuses an invalid config" 1 "$(SSH_CONNECTION=$KEY_SESSION run --apply)" 'sshd -t rejected'
[ ! -e "$T/d/10-eje-hardening.conf" ] && ! grep -q '^systemd-run' "$T/calls" && ok "...no drop-in, no timer" || no "...no drop-in, no timer"

# 7. --apply: if the revert cannot be armed, passwords are NOT turned off
sandbox; touch "$T/arm_fails"
expect "apply refuses when the revert cannot be armed" 1 "$(SSH_CONNECTION=$KEY_SESSION run --apply)" 'could not arm'
[ ! -e "$T/d/10-eje-hardening.conf" ] && ! grep -q '^systemctl reload' "$T/calls" && ok "...no drop-in, no reload" || no "...no drop-in, no reload"

# 8. THE 24 OCTOBER FAILURE: the revert already fired; --confirm must say so, not "confirm"
sandbox
SSH_CONNECTION=$KEY_SESSION run --apply > /dev/null
rm -f "$T/timer" "$T/d/10-eje-hardening.conf"; echo publickey,password > "$T/live"   # the timer fired
new_login
expect "confirm refuses once the revert has already run" 1 "$(SSH_CONNECTION=$NEW_KEY_SESSION run --confirm)" 'NOT pending'

# 9. --confirm refuses from a password session, and leaves the revert armed
sandbox
SSH_CONNECTION=$KEY_SESSION run --apply > /dev/null
expect "confirm refuses from a password session" 1 "$(SSH_CONNECTION=$PW_SESSION run --confirm)" 'did not log in with a key'
[ -e "$T/timer" ] && ok "...auto-revert still armed" || no "...auto-revert still armed"

# 10. --confirm refuses when the live daemon offers passwords (files changed, daemon not reloaded)
sandbox
SSH_CONNECTION=$KEY_SESSION run --apply > /dev/null
echo publickey,password > "$T/live"; new_login
expect "confirm refuses when the live daemon offers passwords" 1 "$(SSH_CONNECTION=$NEW_KEY_SESSION run --confirm)" 'still offers passwords'
[ -e "$T/timer" ] && ok "...auto-revert still armed" || no "...auto-revert still armed"

# 11. --confirm succeeds from a key session and cancels the revert
sandbox
SSH_CONNECTION=$KEY_SESSION run --apply > /dev/null
new_login
expect "confirm succeeds from a NEW key session" 0 "$(SSH_CONNECTION=$NEW_KEY_SESSION run --confirm)" 'CONFIRMED'
[ ! -e "$T/timer" ] && [ -e "$T/d/10-eje-hardening.conf" ] && ok "...revert cancelled, drop-in kept" || no "...revert cancelled, drop-in kept"

# 11b. --confirm from the SAME session that ran --apply proves nothing, and is refused
sandbox
SSH_CONNECTION=$KEY_SESSION run --apply > /dev/null
expect "confirm refuses from the session that ran --apply" 1 "$(SSH_CONNECTION=$KEY_SESSION run --confirm)" 'opened before --apply'
[ -e "$T/timer" ] && ok "...auto-revert still armed" || no "...auto-revert still armed"

# 12. --status is read-only
sandbox
expect "status reports the live daemon" 0 "$(run --status)" 'live daemon: +offers publickey,password'
! grep -qE '^(systemd-run|systemctl (reload|stop))' "$T/calls" && ok "...and changes nothing" || no "...and changes nothing"

# 13. a second --apply while a revert is pending is refused
sandbox
SSH_CONNECTION=$KEY_SESSION run --apply > /dev/null; rm -f "$T/d/10-eje-hardening.conf"
expect "apply refuses while a revert is pending" 1 "$(SSH_CONNECTION=$KEY_SESSION run --apply)" 'already pending'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
