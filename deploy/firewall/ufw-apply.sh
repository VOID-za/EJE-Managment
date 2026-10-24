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
#   seen, not silently cut off or silently left open.
#
# THE DEAD-MAN'S SWITCH. Before UFW is enabled, a transient systemd timer is
# armed to run `ufw disable` in REVERT_SECONDS (default 300). If this change
# cuts SSH, the server reopens itself without anybody needing a console. To
# KEEP the firewall, open a NEW SSH session — which is the proof that new
# connections still work — and run:
#
#   systemctl stop eje-ufw-revert.timer
#
# Configuration is backed up first to /root/ufw-backup-<stamp>.tar.gz.
# Rollback at any time: `ufw disable` (the state before this script).
set -u
MODE=${1:-}
REVERT_SECONDS=${REVERT_SECONDS:-300}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
say() { printf '%s\n' "$*"; }
die() { say "REFUSED: $*"; exit 1; }

[ "$MODE" = --check ] || [ "$MODE" = --apply ] || die "say --check or --apply"
[ "$(id -u)" -eq 0 ] || die "run as root"
command -v ufw >/dev/null || die "ufw is not installed (apt-get install ufw)"
command -v sshd >/dev/null || die "sshd not found; refusing to guess the SSH port"

# ---- the SSH ports, from the daemon itself -----------------------------------
CONFIGURED=$(sshd -T 2>/dev/null | awk '$1=="port"{print $2}' | sort -un)
LISTENING=$(ss -Htlnp 2>/dev/null | awk '/"sshd"/ {n=split($4,a,":"); print a[n]}' | sort -un)
# systemd socket activation (ssh.socket) shows the listener as systemd, not sshd
SOCKET=$(systemctl show ssh.socket -p Listen 2>/dev/null | grep -oE '[0-9]+ \(Stream\)' | awk '{print $1}' | sort -un)
SESSION=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $4}')
SSH_PORTS=$(printf '%s\n' $CONFIGURED $LISTENING $SOCKET $SESSION | grep -E '^[0-9]+$' | sort -un | paste -sd' ')
[ -n "$SSH_PORTS" ] || die "could not determine any SSH port"
say "sshd configured port(s): ${CONFIGURED:-none}   listening: ${LISTENING:-none}   socket: ${SOCKET:-none}   this session: ${SESSION:-not over SSH}"
for p in $SSH_PORTS; do
  if ! ss -Htln "( sport = :$p )" | grep -q .; then
    say "WARNING: SSH port $p is not listening right now"
  fi
done

# ---- anything else exposed ---------------------------------------------------
say "public listeners (not loopback):"
ss -Htulpn | awk '{print $1, $5, $7}' | grep -vE ' (127\.[0-9.]+|\[::1\]):' | sed -E 's/users:\(\("([^"]+)".*/\1/' | sort -u | sed 's/^/  /'

PLAN=()
for p in $SSH_PORTS; do PLAN+=("allow $p/tcp comment SSH"); done
PLAN+=("allow 80/tcp comment HTTP-Caddy" "allow 443/tcp comment HTTPS-Caddy" "allow 443/udp comment HTTP3-Caddy")

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
tar -czf "/root/ufw-backup-$STAMP.tar.gz" /etc/ufw /etc/default/ufw 2>/dev/null || die "could not back up /etc/ufw"
chmod 600 "/root/ufw-backup-$STAMP.tar.gz"
say "backup: /root/ufw-backup-$STAMP.tar.gz"

systemctl stop eje-ufw-revert.timer 2>/dev/null; systemctl reset-failed eje-ufw-revert.service 2>/dev/null
systemd-run --quiet --unit=eje-ufw-revert --on-active="$REVERT_SECONDS" /usr/sbin/ufw disable \
  || die "could not arm the revert timer — firewall NOT enabled"
systemctl is-active --quiet eje-ufw-revert.timer || die "revert timer not active — firewall NOT enabled"
say "revert armed: ufw disable in ${REVERT_SECONDS}s unless 'systemctl stop eje-ufw-revert.timer' is run from a NEW SSH session"

sed -i 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw default deny routed >/dev/null
for r in "${PLAN[@]}"; do
  # shellcheck disable=SC2086
  ufw $r >/dev/null || { ufw disable; die "rule failed: $r — firewall disabled again"; }
done
ufw --force enable
ufw status verbose

say ""
say "health through Caddy from here: $(curl -s -o /dev/null -w '%{http_code}' -m 15 https://eje.syncza.co.za/api/health)"
say "app on loopback: $(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:3000/api/health)"
say ""
say "NOW: open a NEW SSH session and run:  systemctl stop eje-ufw-revert.timer"
say "If you cannot connect, wait ${REVERT_SECONDS}s: UFW disables itself."
