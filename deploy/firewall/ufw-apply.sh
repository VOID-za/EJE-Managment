#!/bin/bash
# EJE host firewall — UFW, applied with a dead-man's switch. Security audit, 24 October 2026.
#
#   sudo bash deploy/firewall/ufw-apply.sh --check   # read-only: what it WOULD do, and why
#   sudo bash deploy/firewall/ufw-apply.sh --apply   # back up, arm auto-revert, enable
#
# WHAT IS ALLOWED IN, AND WHY NOTHING ELSE IS:
#   - every port sshd is ACTUALLY listening on (read from `sshd -T` and `ss`,
#     never assumed to be 22), plus the port of the session running this;
#   - 80/tcp and 443/tcp for Caddy, and 443/udp for HTTP/3, which Caddy serves.
#   PostgreSQL (5432) and the application (3000) listen on loopback only and need
#   no rule; anything else listening on a public address is REPORTED so it is
#   seen, not silently cut off or silently left open. SSH is `allow`, not
#   `limit`: limit blocks a 6th connection in 30 s, which a guarded stage makes.
#
# THE DEAD-MAN'S SWITCH. Before UFW is enabled, a transient systemd timer is
# armed to run `ufw disable` in REVERT_SECONDS (default 900 — 300 proved too
# short for a confirmation relayed by a person, on 24 October). If this change
# cuts SSH, the server reopens itself without anybody needing a console. To
# KEEP the firewall, open a NEW SSH session and run --confirm there. It refuses
# unless the revert is still PENDING, UFW is active, every planned allow rule
# (SSH, 80, 443) is in the ACTIVE ruleset for IPv4 and IPv6, and the session it
# runs in logged in AFTER the firewall went up — an established session
# survives a firewall change and proves nothing.
#
#   --confirm   from a NEW SSH login: verify, then cancel the auto-revert
#   --status    read-only: firewall state and time left
#
# RULES ALREADY SAVED IN UFW. `ufw enable` activates every rule ever added, not
# only this plan. --check lists them, and --check/--apply REFUSE if any is a
# deny, reject or limit rule, which could cut SSH the moment UFW goes up.
#
# NEVER HALF-APPLIED. If a default, a rule, the enable, or the post-enable check
# fails, --apply disables UFW again and stops the timer before it exits.
#
# Configuration is backed up first to /root/ufw-backup-<stamp>.tar.gz.
# Rollback at any time: `ufw disable` (the state before this script).
set -u
MODE=${1:-}
REVERT_SECONDS=${REVERT_SECONDS:-900}
ARMED_FILE=${ARMED_FILE:-/run/eje-ufw-armed}
UFW_DEFAULTS=${UFW_DEFAULTS:-/etc/default/ufw}
BACKUP_DIR=${BACKUP_DIR:-/root}
UNIT=eje-ufw-revert
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
say() { printf '%s\n' "$*"; }
die() { say "REFUSED: $*"; exit 1; }

case "$MODE" in --check|--apply|--confirm|--status) ;; *) die "say --check, --apply, --confirm or --status";; esac
[ "$(id -u)" -eq 0 ] || die "run as root"

revert_pending() { systemctl is-active --quiet "$UNIT.timer"; }
status() {
  say "ufw:         $(ufw status | head -1)"
  if revert_pending; then
    say "auto-revert: PENDING — $(systemctl list-timers "$UNIT.timer" --no-pager 2>/dev/null | sed -n 2p | awk '{print $1,$2,$3,$4, "(" $5, $6 " left)"}')"
  else
    say "auto-revert: not pending"
  fi
}
# When THIS session logged in (any method), as epoch seconds, matched on SSH_CONNECTION.
session_login() {
  local ip port line
  ip=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $1}')
  port=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $2}')
  [ -n "$port" ] || return 2
  line=$(journalctl -u ssh -u sshd --no-pager --since "-2h" -o short-unix 2>/dev/null \
    | grep -E "Accepted [a-z-]+ for [a-z0-9_-]+ from $ip port $port " | tail -1)
  [ -n "$line" ] || return 1
  printf '%s' "$line" | awk '{print int($1)}'
}
# The SSH ports, from the daemon itself, and the plan built on them.
ssh_ports() {
  CONFIGURED=$(sshd -T 2>/dev/null | awk '$1=="port"{print $2}' | sort -un)
  LISTENING=$(ss -Htlnp 2>/dev/null | awk '/"sshd"/ {n=split($4,a,":"); print a[n]}' | sort -un)
  # systemd socket activation (ssh.socket) shows the listener as systemd, not sshd
  SOCKET=$(systemctl show ssh.socket -p Listen 2>/dev/null | grep -oE '[0-9]+ \(Stream\)' | awk '{print $1}' | sort -un)
  SESSION=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $4}')
  SSH_PORTS=$(printf '%s\n' $CONFIGURED $LISTENING $SOCKET $SESSION | grep -E '^[0-9]+$' | sort -un | paste -sd' ')
  [ -n "$SSH_PORTS" ] || die "could not determine any SSH port"
  PLAN=()
  for p in $SSH_PORTS; do PLAN+=("allow $p/tcp comment SSH"); done
  PLAN+=("allow 80/tcp comment HTTP-Caddy" "allow 443/tcp comment HTTPS-Caddy" "allow 443/udp comment HTTP3-Caddy")
}
# Every planned allow rule is in the ACTIVE ruleset, IPv4 and IPv6. Prints what is missing.
rules_enforced() {
  local st r spec missing=0
  st=$(ufw status 2>/dev/null)
  printf '%s\n' "$st" | grep -q '^Status: active' || { say "  UFW is not active"; return 1; }
  for r in "${PLAN[@]}"; do
    spec=$(printf '%s' "$r" | awk '{print $2}')
    printf '%s\n' "$st" | grep -qE "^${spec} +ALLOW( IN)? +Anywhere( |$)" || { say "  missing: $spec (IPv4)"; missing=1; }
    printf '%s\n' "$st" | grep -qE "^${spec} \(v6\) +ALLOW( IN)? +Anywhere \(v6\)" || { say "  missing: $spec (IPv6)"; missing=1; }
  done
  return $missing
}

if [ "$MODE" = --status ]; then status; exit 0; fi
if [ "$MODE" = --confirm ]; then
  status
  revert_pending || die "the auto-revert is NOT pending — it has already run or was never armed (journalctl -t $UNIT). Nothing to confirm."
  ufw status | grep -q '^Status: active' || die "UFW is not active — nothing to confirm."
  ssh_ports
  rules_enforced || die "the active ruleset is missing a planned allow rule (above) — not confirming; the auto-revert stays armed."
  say "active ruleset: SSH ($SSH_PORTS), 80/tcp, 443/tcp, 443/udp allowed, IPv4 and IPv6"
  LOGIN=$(session_login); rc=$?
  [ "$rc" -ne 2 ] || die "not run over SSH — confirm from a NEW SSH login."
  [ "$rc" -eq 0 ] || die "this session's login is not in the journal — open a NEW SSH login."
  # An ESTABLISHED session survives a firewall change; only a login made after it proves anything.
  [ "$LOGIN" -ge "$(cat "$ARMED_FILE" 2>/dev/null || echo 0)" ] \
    || die "this session was opened before the firewall went up, so it proves nothing — open a NEW SSH login and run --confirm there."
  systemctl stop "$UNIT.timer" || die "could not stop the auto-revert"
  revert_pending && die "the auto-revert is still pending after stopping it"
  logger -t "$UNIT" "confirmed from a new SSH login; auto-revert cancelled" 2>/dev/null
  say ""; say "CONFIRMED. Firewall kept; a new SSH login got through it."; status
  exit 0
fi
command -v ufw >/dev/null || die "ufw is not installed (apt-get install ufw)"
command -v sshd >/dev/null || die "sshd not found; refusing to guess the SSH port"

ssh_ports
say "sshd configured port(s): ${CONFIGURED:-none}   listening: ${LISTENING:-none}   socket: ${SOCKET:-none}   this session: ${SESSION:-not over SSH}"
for p in $SSH_PORTS; do
  if ! ss -Htln "( sport = :$p )" | grep -q .; then
    say "WARNING: SSH port $p is not listening right now"
  fi
done

# ---- anything else exposed ---------------------------------------------------
say "public listeners (not loopback):"
ss -Htulpn | awk '{print $1, $5, $7}' | grep -vE ' (127\.[0-9.]+|\[::1\]):' | sed -E 's/users:\(\("([^"]+)".*/\1/' | sort -u | sed 's/^/  /'

# ---- rules already saved in UFW: enable activates them too -------------------
EXISTING=$(ufw show added 2>/dev/null | grep -E '^ufw ')
say "rules already saved in UFW (enable activates these too):"
if [ -n "$EXISTING" ]; then printf '%s\n' "$EXISTING" | sed 's/^/  /'; else say "  none"; fi
if printf '%s\n' "$EXISTING" | grep -qE '^ufw +(insert +[0-9]+ +)?(deny|reject|limit)( |$)'; then
  die "a saved deny/reject/limit rule (above) would come into force with the firewall and could cut SSH — review it with 'ufw show added' first. Nothing was changed."
fi

say ""
say "planned: default deny incoming, allow outgoing, deny routed; IPv6 on"
for r in "${PLAN[@]}"; do say "  ufw $r"; done
say "current: $(ufw status | head -1)"

if [ "$MODE" = --check ]; then
  say ""; say "CHECK ONLY — nothing was changed."
  exit 0
fi

# ---- apply ---------------------------------------------------------------------
[ -n "$SESSION" ] || say "NOTE: not running over SSH; the revert timer is still armed."
revert_pending && die "an auto-revert is already pending — run --confirm or --status first"
BACKUP="$BACKUP_DIR/ufw-backup-$STAMP.tar.gz"
tar -czf "$BACKUP" /etc/ufw "$UFW_DEFAULTS" 2>/dev/null || die "could not back up /etc/ufw"
chmod 600 "$BACKUP"
say "backup: $BACKUP"

systemctl reset-failed "$UNIT.service" "$UNIT.timer" 2>/dev/null
# AccuracySec=1s: a transient timer otherwise fires up to a MINUTE late (the
# systemd default), which makes the printed deadline a guess.
systemd-run --quiet --unit="$UNIT" --on-active="$REVERT_SECONDS" --timer-property=AccuracySec=1s /bin/sh -c \
  "logger -t $UNIT 'auto-revert firing: ufw disable'; /usr/sbin/ufw disable; logger -t $UNIT 'auto-revert done'" \
  || die "could not arm the revert timer — firewall NOT enabled"
revert_pending || die "revert timer not active — firewall NOT enabled"
DEADLINE=$(date -u -d "+${REVERT_SECONDS} seconds" '+%H:%M:%S UTC' 2>/dev/null || echo "in ${REVERT_SECONDS}s")
say "revert armed: ufw disable at $DEADLINE unless --confirm is run from a NEW SSH session"

# From here on, any failure backs out completely: firewall off, timer stopped.
abort() {
  ufw disable >/dev/null 2>&1
  systemctl stop "$UNIT.timer" 2>/dev/null
  logger -t "$UNIT" "apply aborted: $*" 2>/dev/null
  die "$* — UFW disabled again and the auto-revert stopped; nothing is in force"
}
sed -i 's/^IPV6=.*/IPV6=yes/' "$UFW_DEFAULTS" || abort "could not set IPV6=yes"
ufw default deny incoming >/dev/null || abort "could not set default deny incoming"
ufw default allow outgoing >/dev/null || abort "could not set default allow outgoing"
ufw default deny routed >/dev/null || abort "could not set default deny routed"
for r in "${PLAN[@]}"; do
  # shellcheck disable=SC2086
  ufw $r >/dev/null || abort "rule failed: $r"
done
ufw --force enable >/dev/null || abort "ufw enable failed"
rules_enforced || abort "after enable, the active ruleset is missing a planned rule"
date -u +%s > "$ARMED_FILE"
logger -t "$UNIT" "enabled: reverts in ${REVERT_SECONDS}s unless confirmed" 2>/dev/null
ufw status verbose

say ""
say "health through Caddy from here: $(curl -s -o /dev/null -w '%{http_code}' -m 15 https://eje.syncza.co.za/api/health)"
say "app on loopback: $(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:3000/api/health)"
say ""
say "APPLIED. Before $DEADLINE: open a NEW SSH session and run:  bash ufw-apply.sh --confirm"
say "If you cannot connect, do nothing: UFW disables itself at $DEADLINE."
exit 0
