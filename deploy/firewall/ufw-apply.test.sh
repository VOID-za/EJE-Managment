#!/bin/bash
# Tests for ufw-apply.sh — every mode, against stub commands (a stateful fake ufw).
#   bash deploy/firewall/ufw-apply.test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/ufw-apply.sh"
PASS=0; FAIL=0

sandbox() {
  T=$(mktemp -d); mkdir -p "$T/bin"; : > "$T/calls"; : > "$T/rules"; : > "$T/saved"
  echo 'IPV6=no' > "$T/default-ufw"
  NOW=$(date -u +%s)
  echo "$((NOW-600)).0 srv sshd[1]: Accepted publickey for root from 198.51.100.7 port 50000 ssh2" > "$T/journal"
  stub() { printf '#!/bin/bash\n%s\n' "$2" > "$T/bin/$1"; chmod +x "$T/bin/$1"; }
  stub id 'echo 0'
  stub logger 'echo "logger $*" >> "$T/calls"'
  stub sshd 'printf "port 22\npubkeyauthentication yes\n"'
  stub ss 'echo "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=1,fd=3))"'
  stub journalctl 'cat "$T/journal"'
  stub tar 'echo "tar $*" >> "$T/calls"; : > "$2"'
  stub curl 'echo 200'
  stub systemd-run 'echo "systemd-run $*" >> "$T/calls"; touch "$T/timer"'
  # A stateful ufw: saved rules, an on/off switch, and the status listing ufw prints.
  stub ufw 'echo "ufw $*" >> "$T/calls"
case "$1" in
  status) if [ -e "$T/active" ]; then printf "Status: active\n\nTo                         Action      From\n--                         ------      ----\n"; cat "$T/rules"; else echo "Status: inactive"; fi;;
  show) echo "Added user rules (see '"'"'ufw status'"'"' for running firewall):"; if [ -s "$T/saved" ]; then cat "$T/saved"; else echo "(None)"; fi;;
  allow) [ -e "$T/fail-${2////_}" ] && exit 1
         echo "ufw $*" >> "$T/saved"
         printf "%-26s ALLOW       Anywhere                   # %s\n" "$2" "$4" >> "$T/rules"
         [ -e "$T/no-v6" ] || printf "%-26s ALLOW       Anywhere (v6)              # %s\n" "$2 (v6)" "$4" >> "$T/rules";;
  --force) [ -e "$T/fail-enable" ] && exit 1; touch "$T/active";;
  disable) rm -f "$T/active";;
esac; exit 0'
  stub systemctl 'echo "systemctl $*" >> "$T/calls"
case "$1" in is-active) [ -e "$T/timer" ];; stop) rm -f "$T/timer";; list-timers) echo NEXT; echo "Fri 2026-10-24 20:15:00 UTC 14min left";; show) echo "Listen=[::]:22 (Stream)";; *) :;; esac'
  export T
}
run() { PATH="$T/bin:$PATH" ARMED_FILE="$T/armed" UFW_DEFAULTS="$T/default-ufw" BACKUP_DIR="$T" bash "$SCRIPT" "$1" > "$T/out" 2>&1; echo $?; }
OLD='198.51.100.7 50000 203.0.113.1 22'
NEW='198.51.100.7 50001 203.0.113.1 22'
new_login() { echo "$(( $(date -u +%s) + 5 )).0 srv sshd[2]: Accepted publickey for root from 198.51.100.7 port 50001 ssh2" >> "$T/journal"; }
# The state --apply leaves behind: timer armed, UFW active, the planned rules in force.
applied() { SSH_CONNECTION=$OLD run --apply > /dev/null; }
ok() { PASS=$((PASS+1)); printf 'ok   %s\n' "$1"; }
no() { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$1"; sed 's/^/     | /' "$T/out"; }
expect() { if [ "$2" = "$3" ] && { [ -z "${4:-}" ] || grep -qE "$4" "$T/out"; }; then ok "$1"; else no "$1 (exit $3, wanted $2${4:+, /$4/})"; fi; }
changed() { grep -qE '^(ufw (allow|default|--force|enable)|systemd-run|tar)' "$T/calls"; }

# ---- --check ----
sandbox
expect "check plans SSH 22, 80, 443 and 443/udp" 0 "$(SSH_CONNECTION=$OLD run --check)" 'allow 22/tcp'
grep -q 'allow 443/udp' "$T/out" && grep -q 'saved in UFW' "$T/out" && ! changed && ok "...lists saved rules, read-only" || no "...lists saved rules, read-only"

sandbox; echo "ufw deny 22/tcp" > "$T/saved"
expect "check refuses when a saved deny rule would come into force" 1 "$(SSH_CONNECTION=$OLD run --check)" 'deny/reject/limit'
sandbox; echo "ufw limit 22/tcp" > "$T/saved"
expect "apply refuses on a saved limit rule, before any change" 1 "$(SSH_CONNECTION=$OLD run --apply)" 'Nothing was changed'
! changed && ok "...nothing armed, backed up or enabled" || no "...nothing armed, backed up or enabled"

# ---- --apply ----
sandbox
expect "apply: backs up, arms, enables, verifies the active rules" 0 "$(SSH_CONNECTION=$OLD run --apply)" 'APPLIED'
[ -e "$T/timer" ] && [ -e "$T/active" ] && [ -s "$T/armed" ] && ok "...timer armed, UFW active, armed time recorded" || no "...timer armed, UFW active, armed time recorded"
grep -q '^tar ' "$T/calls" && grep -q 'IPV6=yes' "$T/default-ufw" && ok "...config backed up first, IPv6 on" || no "...config backed up first, IPv6 on"
[ "$(grep -n '^systemd-run' "$T/calls" | cut -d: -f1)" -lt "$(grep -n '^ufw --force enable' "$T/calls" | cut -d: -f1)" ] \
  && ok "...auto-revert armed BEFORE the firewall goes up" || no "...auto-revert armed BEFORE the firewall goes up"
grep -q -- '--on-active=900 --timer-property=AccuracySec=1s' "$T/calls" && ok "...900 s window, on time" || no "...900 s window, on time"

sandbox; touch "$T/fail-443_tcp"
expect "apply: a failed rule backs out completely" 1 "$(SSH_CONNECTION=$OLD run --apply)" 'nothing is in force'
[ ! -e "$T/timer" ] && [ ! -e "$T/active" ] && ok "...UFW off, timer stopped" || no "...UFW off, timer stopped"

sandbox; touch "$T/fail-enable"
expect "apply: a failed enable backs out completely" 1 "$(SSH_CONNECTION=$OLD run --apply)" 'nothing is in force'
[ ! -e "$T/timer" ] && [ ! -e "$T/active" ] && ok "...UFW off, timer stopped" || no "...UFW off, timer stopped"

sandbox; touch "$T/no-v6"
expect "apply: rules missing from the active ruleset back out" 1 "$(SSH_CONNECTION=$OLD run --apply)" 'missing: 22/tcp \(IPv6\)'
[ ! -e "$T/timer" ] && [ ! -e "$T/active" ] && ok "...UFW off, timer stopped" || no "...UFW off, timer stopped"

sandbox; applied
expect "apply refuses while an auto-revert is pending" 1 "$(SSH_CONNECTION=$OLD run --apply)" 'already pending'

# ---- --confirm ----
sandbox
expect "confirm refuses when the revert already ran" 1 "$(SSH_CONNECTION=$NEW run --confirm)" 'NOT pending'

sandbox; applied
expect "confirm refuses from a session opened before the firewall" 1 "$(SSH_CONNECTION=$OLD run --confirm)" 'opened before the firewall'
[ -e "$T/timer" ] && ok "...auto-revert still armed" || no "...auto-revert still armed"

sandbox; applied; rm -f "$T/active"; new_login
expect "confirm refuses when UFW is not active" 1 "$(SSH_CONNECTION=$NEW run --confirm)" 'not active'

sandbox; applied; grep -v '^80/tcp ' "$T/rules" > "$T/r2"; mv "$T/r2" "$T/rules"; new_login
expect "confirm refuses when a planned rule is not in force" 1 "$(SSH_CONNECTION=$NEW run --confirm)" 'missing: 80/tcp \(IPv4\)'
[ -e "$T/timer" ] && ok "...auto-revert still armed" || no "...auto-revert still armed"

sandbox; applied; new_login
expect "confirm succeeds from a NEW login with every rule in force" 0 "$(SSH_CONNECTION=$NEW run --confirm)" 'CONFIRMED'
[ ! -e "$T/timer" ] && [ -e "$T/active" ] && ok "...auto-revert cancelled, firewall kept" || no "...auto-revert cancelled, firewall kept"

sandbox; applied
expect "status shows the pending revert" 0 "$(run --status)" 'PENDING'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
