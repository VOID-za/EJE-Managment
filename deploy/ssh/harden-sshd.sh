#!/bin/bash
# EJE SSH hardening — keys only, with a dead-man's switch. Security audit, 24 October 2026.
#
#   sudo bash deploy/ssh/harden-sshd.sh --check   # read-only: is it safe to turn passwords off?
#   sudo bash deploy/ssh/harden-sshd.sh --apply   # install the drop-in, arm auto-revert, reload
#
# THE FINDING. Root could log in with a PASSWORD from anywhere on the internet
# (PermitRootLogin yes, PasswordAuthentication yes, 29 such logins in a week,
# no fail2ban). A firewall cannot help: port 22 must stay open for the owner.
#
# WHAT THIS CHANGES — one file, /etc/ssh/sshd_config.d/10-eje-hardening.conf:
#   PasswordAuthentication no, KbdInteractiveAuthentication no,
#   PermitRootLogin prohibit-password (root by KEY only), MaxAuthTries 3.
# sshd takes the FIRST value it reads and includes sshd_config.d/*.conf in
# lexical order, so 10- wins over the cloud image's 50-cloud-init.conf, which is
# where `PasswordAuthentication yes` comes from. Nothing else is edited.
#
# IT REFUSES unless root has an authorized key AND root has logged in WITH A
# KEY in the last 24 hours — proof the key actually works, not just that a
# file exists. Then it validates with `sshd -t` and arms a systemd timer that
# REMOVES the drop-in and reloads sshd in REVERT_SECONDS (default 300). Existing
# sessions are never dropped by a reload. To KEEP it, log in again WITH THE KEY
# in a NEW session and run:
#
#   systemctl stop eje-sshd-revert.timer
#
# Rollback at any time: rm the drop-in, `sshd -t && systemctl reload ssh`.
set -u
MODE=${1:-}
REVERT_SECONDS=${REVERT_SECONDS:-300}
DROPIN=/etc/ssh/sshd_config.d/10-eje-hardening.conf
say() { printf '%s\n' "$*"; }
die() { say "REFUSED: $*"; exit 1; }

[ "$MODE" = --check ] || [ "$MODE" = --apply ] || die "say --check or --apply"
[ "$(id -u)" -eq 0 ] || die "run as root"

say "effective now: $(sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|maxauthtries) ' | paste -sd' ')"
KEYS=$(grep -cE '^(ssh-(ed25519|rsa)|ecdsa-sha2-|sk-)' /root/.ssh/authorized_keys 2>/dev/null || echo 0)
say "root authorized keys: $KEYS"
KEYLOGINS=$(journalctl -u ssh -u sshd --no-pager --since "-24h" 2>/dev/null | grep -c 'Accepted publickey for root')
say "root logins WITH A KEY in the last 24h: $KEYLOGINS"
[ "$(sshd -T 2>/dev/null | awk '$1=="pubkeyauthentication"{print $2}')" = yes ] || die "pubkey authentication is off"
[ "$KEYS" -gt 0 ] || die "root has no authorized key — passwords off would lock everyone out"
[ "$KEYLOGINS" -gt 0 ] || die "no root key login in 24h — log in once with the key first, so it is PROVEN to work"

if [ "$MODE" = --check ]; then say ""; say "CHECK ONLY — safe to apply; nothing was changed."; exit 0; fi

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

systemctl stop eje-sshd-revert.timer 2>/dev/null; systemctl reset-failed eje-sshd-revert.service 2>/dev/null
systemd-run --quiet --unit=eje-sshd-revert --on-active="$REVERT_SECONDS" \
  /bin/sh -c "rm -f $DROPIN && sshd -t && systemctl reload ssh" \
  || { rm -f "$DROPIN"; die "could not arm the revert timer — drop-in removed, nothing reloaded"; }
systemctl reload ssh || { rm -f "$DROPIN"; systemctl stop eje-sshd-revert.timer; die "reload failed — drop-in removed"; }

say "now in effect: $(sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|maxauthtries) ' | paste -sd' ')"
say ""
say "THIS SESSION IS UNAFFECTED. Within ${REVERT_SECONDS}s, from a NEW terminal, log in WITH THE KEY and run:"
say "  systemctl stop eje-sshd-revert.timer"
say "If that login fails, do nothing: passwords come back on their own in ${REVERT_SECONDS}s."
