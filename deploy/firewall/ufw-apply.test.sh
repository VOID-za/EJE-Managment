#!/bin/bash
# Tests for ufw-apply.sh --check / --confirm / --status against stub commands.
#   bash deploy/firewall/ufw-apply.test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/ufw-apply.sh"
PASS=0; FAIL=0

sandbox() {
  T=$(mktemp -d); mkdir -p "$T/bin"; : > "$T/calls"
  NOW=$(date -u +%s)
  echo "$((NOW-600)).0 srv sshd[1]: Accepted publickey for root from 198.51.100.7 port 50000 ssh2" > "$T/journal"
  stub() { printf '#!/bin/bash\n%s\n' "$2" > "$T/bin/$1"; chmod +x "$T/bin/$1"; }
  stub id 'echo 0'
  stub logger 'echo "logger $*" >> "$T/calls"'
  stub sshd 'printf "port 22\npubkeyauthentication yes\n"'
  stub ss 'echo "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=1,fd=3))"'
  stub journalctl 'cat "$T/journal"'
  stub ufw 'echo "ufw $*" >> "$T/calls"; if [ "$1" = status ]; then [ -e "$T/active" ] && echo "Status: active" || echo "Status: inactive"; fi'
  stub systemctl 'echo "systemctl $*" >> "$T/calls"
case "$1" in is-active) [ -e "$T/timer" ];; stop) rm -f "$T/timer";; list-timers) echo NEXT; echo "Fri 2026-10-24 20:15:00 UTC 14min left";; show) echo "Listen=[::]:22 (Stream)";; *) :;; esac'
  export T
}
run() { PATH="$T/bin:$PATH" ARMED_FILE="$T/armed" bash "$SCRIPT" "$1" > "$T/out" 2>&1; echo $?; }
OLD='198.51.100.7 50000 203.0.113.1 22'
NEW='198.51.100.7 50001 203.0.113.1 22'
new_login() { echo "$(( $(date -u +%s) + 5 )).0 srv sshd[2]: Accepted publickey for root from 198.51.100.7 port 50001 ssh2" >> "$T/journal"; }
armed_now() { touch "$T/timer" "$T/active"; date -u +%s > "$T/armed"; }
ok() { PASS=$((PASS+1)); printf 'ok   %s\n' "$1"; }
no() { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$1"; sed 's/^/     | /' "$T/out"; }
expect() { if [ "$2" = "$3" ] && { [ -z "${4:-}" ] || grep -qE "$4" "$T/out"; }; then ok "$1"; else no "$1 (exit $3, wanted $2${4:+, /$4/})"; fi; }

sandbox
expect "check plans SSH 22, 80, 443 and 443/udp and changes nothing" 0 "$(SSH_CONNECTION=$OLD run --check)" 'allow 22/tcp'
grep -q 'allow 443/udp' "$T/out" && ! grep -qE '^ufw (enable|--force|default|allow)' "$T/calls" && ok "...read-only" || no "...read-only"

sandbox
expect "confirm refuses when the revert already ran" 1 "$(SSH_CONNECTION=$NEW run --confirm)" 'NOT pending'

sandbox; armed_now
expect "confirm refuses from a session opened before the firewall" 1 "$(SSH_CONNECTION=$OLD run --confirm)" 'opened before the firewall'
[ -e "$T/timer" ] && ok "...auto-revert still armed" || no "...auto-revert still armed"

sandbox; armed_now; rm -f "$T/active"; new_login
expect "confirm refuses when UFW is not active" 1 "$(SSH_CONNECTION=$NEW run --confirm)" 'not active'

sandbox; armed_now; new_login
expect "confirm succeeds from a NEW login" 0 "$(SSH_CONNECTION=$NEW run --confirm)" 'CONFIRMED'
[ ! -e "$T/timer" ] && ok "...auto-revert cancelled" || no "...auto-revert cancelled"

sandbox; armed_now
expect "status shows the pending revert" 0 "$(run --status)" 'PENDING'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
