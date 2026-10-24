#!/bin/bash
# EJE SSH hardening — keys only, with a dead-man's switch. Security audit, 24 October 2026.
#
#   bash harden-sshd.sh --check     read-only: is it safe to turn passwords off?
#   bash harden-sshd.sh --apply     install the drop-in, arm the auto-revert, reload, VERIFY the live daemon
#   bash harden-sshd.sh --confirm   from a NEW key login: verify, then cancel the auto-revert
#   bash harden-sshd.sh --status    read-only: drop-in, files, live daemon, time left
#
# THE FINDING. Root could log in with a PASSWORD from anywhere on the internet
# (PermitRootLogin yes, PasswordAuthentication yes from the cloud image's
# 50-cloud-init.conf, 29 such logins in a week, no fail2ban).
#
# WHAT IT CHANGES — one file, /etc/ssh/sshd_config.d/10-eje-hardening.conf:
# passwords and keyboard-interactive off, root by key only, MaxAuthTries 3.
# sshd takes the FIRST value it reads and includes sshd_config.d/*.conf in
# lexical order, so 10- wins over 50-cloud-init.conf. Nothing else is edited.
#
# WHAT WENT WRONG THE FIRST TIME (24 October), and what this version does about it:
#   1. The window was 300 s and the confirmation was relayed by a person; the
#      revert fired first. The default is now 900 s and --apply prints the
#      deadline in UTC.
#   2. "Confirm" was `systemctl stop` on the timer plus `sshd -T`. `sshd -T`
#      reads the config FILES, not the running daemon, and stopping a timer that
#      has already fired succeeds silently — so a reverted server looked
#      confirmed. --confirm now refuses unless the revert is still PENDING, the
#      drop-in is still there, the LIVE daemon no longer offers passwords, and
#      the confirming session itself logged in with a key.
#   3. The live daemon is asked directly: a local `ssh -o BatchMode=yes
#      -o PubkeyAuthentication=no root@127.0.0.1` is refused with the list of
#      methods sshd is offering right now. No credential is used or needed.
#   4. The revert logs to the journal (tag eje-sshd-revert) when it fires.
set -u
MODE=${1:-}
REVERT_SECONDS=${REVERT_SECONDS:-900}
DROPIN_DIR=${SSHD_DROPIN_DIR:-/etc/ssh/sshd_config.d}
DROPIN="$DROPIN_DIR/10-eje-hardening.conf"
AUTH_KEYS=${AUTH_KEYS:-/root/.ssh/authorized_keys}
ARMED_FILE=${ARMED_FILE:-/run/eje-sshd-armed}
UNIT=eje-sshd-revert
say() { printf '%s\n' "$*"; }
die() { say "REFUSED: $*"; exit 1; }

effective() { sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|maxauthtries) ' | paste -sd' ' -; }
# The methods the RUNNING daemon offers, e.g. "publickey" or "publickey,password".
advertised() {
  ssh -o BatchMode=yes -o PubkeyAuthentication=no -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 root@127.0.0.1 true 2>&1 \
    | sed -nE 's/.*Permission denied \(([^)]*)\).*/\1/p' | head -1
}
offers_password() { case ",$(advertised)," in *,password,*|*,keyboard-interactive,*) return 0;; *) return 1;; esac; }
revert_pending() { systemctl is-active --quiet "$UNIT.timer"; }
# When THIS session logged in WITH A KEY, as epoch seconds — matched on the
# client address and port in SSH_CONNECTION. Exit 2: not over SSH; 1: not a key login.
session_key_login() {
  local client_ip client_port line
  client_ip=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $1}')
  client_port=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $2}')
  [ -n "$client_port" ] || return 2
  line=$(journalctl -u ssh -u sshd --no-pager --since "-2h" -o short-unix 2>/dev/null \
    | grep "Accepted publickey for root from $client_ip port $client_port " | tail -1)
  [ -n "$line" ] || return 1
  printf '%s' "$line" | awk '{print int($1)}'
}
session_used_key() { session_key_login > /dev/null; }
report() {
  say "drop-in:        $([ -e "$DROPIN" ] && echo present || echo absent)"
  say "config files:   $(effective)"
  say "live daemon:    offers $(advertised)"
  if revert_pending; then
    say "auto-revert:    PENDING — $(systemctl list-timers "$UNIT.timer" --no-pager 2>/dev/null | sed -n 2p | awk '{print $1,$2,$3,$4, "(" $5, $6 " left)"}')"
  else
    say "auto-revert:    not pending"
  fi
}

case "$MODE" in --check|--apply|--confirm|--status) ;; *) die "say --check, --apply, --confirm or --status";; esac
[ "$(id -u)" -eq 0 ] || die "run as root"

if [ "$MODE" = --status ]; then report; exit 0; fi

if [ "$MODE" = --confirm ]; then
  report
  revert_pending || die "the auto-revert is NOT pending — it has already run (see: journalctl -t $UNIT), so the hardening is NOT in place. Nothing to confirm; re-run --apply."
  [ -e "$DROPIN" ] || die "the drop-in is gone although the revert is pending — not confirming."
  if offers_password; then die "the live daemon still offers passwords — not confirming; the auto-revert stays armed."; fi
  LOGIN=$(session_key_login); rc=$?
  [ "$rc" -ne 2 ] || die "not run over SSH — confirm from a NEW SSH login made with the key."
  [ "$rc" -eq 0 ] || die "this session did not log in with a key — open a NEW login with the key."
  ARMED=$(cat "$ARMED_FILE" 2>/dev/null || echo 0)
  # A session opened BEFORE the change proves nothing about it — including the one that ran --apply.
  [ "$LOGIN" -ge "$ARMED" ] || die "this session was opened before --apply, so it does not prove a NEW key login works — open a NEW login and run --confirm there."
  systemctl stop "$UNIT.timer" || die "could not stop the auto-revert"
  revert_pending && die "the auto-revert is still pending after stopping it"
  logger -t "$UNIT" "confirmed from a key login; auto-revert cancelled" 2>/dev/null
  say ""; say "CONFIRMED. Keys only, verified on the live daemon; auto-revert cancelled."
  report
  exit 0
fi

# ---- --check / --apply preconditions --------------------------------------------
report
KEYS=$(grep -cE '^(ssh-(ed25519|rsa)|ecdsa-sha2-|sk-)' "$AUTH_KEYS" 2>/dev/null); KEYS=${KEYS:-0}
say "root authorized keys: $KEYS"
[ "$(sshd -T 2>/dev/null | awk '$1=="pubkeyauthentication"{print $2}')" = yes ] || die "pubkey authentication is off"
[ "$KEYS" -gt 0 ] || die "root has no authorized key — passwords off would lock everyone out"
session_used_key; rc=$?
if [ "$rc" -eq 2 ]; then
  KEYLOGINS=$(journalctl -u ssh -u sshd --no-pager --since "-24h" 2>/dev/null | grep -c 'Accepted publickey for root')
  say "not over SSH; root key logins in the last 24h: $KEYLOGINS"
  [ "${KEYLOGINS:-0}" -gt 0 ] || die "no root key login in 24h — log in once with the key first"
else
  [ "$rc" -eq 0 ] || die "this session did not log in with a key — run --apply from a key login, so the key is PROVEN"
  say "this session logged in with a key: yes"
fi
revert_pending && die "an auto-revert is already pending — run --confirm or --status first"

if [ "$MODE" = --check ]; then say ""; say "CHECK ONLY — safe to apply; nothing was changed."; exit 0; fi

# ---- --apply ----------------------------------------------------------------------
[ -e "$DROPIN" ] && die "$DROPIN already exists — inspect it rather than overwriting"
umask 022
cat > "$DROPIN" <<'EOF'
# EJE security audit, 24 October 2026: keys only. See deploy/ssh/harden-sshd.sh.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
EOF
if ! sshd -t; then rm -f "$DROPIN"; die "sshd -t rejected the configuration — drop-in removed, nothing reloaded"; fi

systemctl reset-failed "$UNIT.service" "$UNIT.timer" 2>/dev/null
# ARMED BEFORE THE RELOAD, so there is never a moment with passwords off and no way back.
# AccuracySec=1s: a transient timer otherwise fires up to a MINUTE late (the
# systemd default), which makes the printed deadline a guess.
systemd-run --quiet --unit="$UNIT" --on-active="$REVERT_SECONDS" --timer-property=AccuracySec=1s /bin/sh -c \
  "logger -t $UNIT 'auto-revert firing: removing $DROPIN'; rm -f '$DROPIN'; if sshd -t; then systemctl reload ssh; logger -t $UNIT 'auto-revert done: passwords allowed again'; else logger -t $UNIT 'auto-revert: sshd -t failed after removal'; fi" \
  || { rm -f "$DROPIN"; die "could not arm the auto-revert — drop-in removed, nothing reloaded"; }
revert_pending || { rm -f "$DROPIN"; die "auto-revert not pending after arming — drop-in removed, nothing reloaded"; }
date -u +%s > "$ARMED_FILE"
logger -t "$UNIT" "armed: reverts in ${REVERT_SECONDS}s unless confirmed" 2>/dev/null

systemctl reload ssh || { rm -f "$DROPIN"; systemctl stop "$UNIT.timer"; die "reload failed — drop-in removed"; }
sleep 2
if offers_password; then
  rm -f "$DROPIN"; systemctl reload ssh; systemctl stop "$UNIT.timer"
  die "after the reload the live daemon STILL offers passwords ($(advertised)) — drop-in removed and reloaded, nothing changed"
fi

DEADLINE=$(date -u -d "+${REVERT_SECONDS} seconds" '+%H:%M:%S UTC' 2>/dev/null || echo "in ${REVERT_SECONDS}s")
say ""
say "APPLIED. The live daemon now offers only: $(advertised)"
say "THIS SESSION IS UNAFFECTED. Before $DEADLINE, from a NEW login WITH THE KEY, run:"
say "  bash harden-sshd.sh --confirm"
say "If that login fails, do nothing: passwords come back on their own at $DEADLINE."
exit 0
