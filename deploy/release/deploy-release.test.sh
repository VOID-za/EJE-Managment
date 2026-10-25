#!/bin/bash
# Tests for deploy-release.sh — every gate, every failure path, every rollback —
# against a sandbox: REAL symlinks, directories and state files under a temp
# directory, and stub commands that play the server. Nothing here can reach a
# real server; the stubs are first on PATH and the script's every path is
# redirected into the sandbox.
#   bash deploy/release/deploy-release.test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/deploy-release.sh"
PASS=0; FAIL=0
SHA=de0d9b6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SHORT=${SHA:0:7}
LIVE=4634d5d

sandbox() {
  T=$(mktemp -d); mkdir -p "$T/bin" "$T/releases/$LIVE/.next" "$T/state"; : > "$T/calls"
  echo "4634d5d061c02f3aa9af034be4363403a87f18cf" > "$T/releases/$LIVE/.sha"
  touch "$T/eje.env" "$T/restore.env"
  stub() { printf '#!/bin/bash\n%s\n' "$2" > "$T/bin/$1"; chmod +x "$T/bin/$1"; }
  # REAL SYMLINKS WHERE THE PLATFORM HAS THEM — CI's Linux, and the server —
  # which is where the atomic `ln -sfn` + `mv -T` switch is proven. Git Bash on
  # Windows without symlink rights COPIES the directory instead, which would
  # test nothing; there, and only there, the three link operations the script
  # uses are played by stand-ins that keep the target in `<link>.link`, so the
  # gate and rollback logic is still exercised.
  if ln -s "$T/releases/$LIVE" "$T/app" 2>/dev/null && [ -L "$T/app" ]; then
    LINKS=real
  else
    LINKS=emulated
    rm -rf "$T/app"; printf '%s\n' "$T/releases/$LIVE" > "$T/app.link"
    stub readlink 'for a; do last=$a; done; if [ -f "$last.link" ]; then cat "$last.link"; else printf "%s\n" "$last"; fi'
    stub ln 'printf "%s\n" "$2" > "$3.link"'
    stub mv 'if [ "$1" = -T ] && [ -f "$2.link" ]; then /usr/bin/mv -f "$2.link" "$3.link"; else /usr/bin/mv "$@"; fi'
  fi
  export LINKS
  stub id 'echo 0'
  stub hostname 'cat "$T/hostname" 2>/dev/null || echo srv2000625'
  stub logger ':'
  stub sleep ':'
  stub flock '[ ! -e "$T/locked" ]'
  stub df 'printf "Filesystem 1M-blocks Used Available Use%% Mounted\n/dev/sda1 100000 50000 ${FREE:-40000} 50%% /\n"'
  stub pdftotext 'echo pdftotext'
  stub pdfinfo 'echo pdfinfo'
  stub install 'echo "install $*" >> "$T/calls"; for a; do last=$a; done; mkdir -p "$last"'
  # git AS THE SERVER'S git BEHAVES: a release directory is owned by eje, and git
  # refuses any other caller — root included — with "dubious ownership". The
  # stub refuses unless it was reached through `runuser -u eje`, and records a
  # root attempt, so a HEAD check run as root fails here exactly as it did on
  # the server on 25 October 2026.
  stub git 'if [ "$1" = -C ] && [ "$3" = rev-parse ]; then
  if [ "${AS_USER:-root}" != eje ]; then echo "git ROOT $*" >> "$T/calls"; echo "fatal: detected dubious ownership in repository at $2" >&2; exit 128; fi
  echo "git eje $*" >> "$T/calls"; cat "$2/.sha" 2>/dev/null
else echo "git $*" >> "$T/calls"; fi'
  stub runuser '[ "$1" = -u ] && [ "$3" = -- ] || { echo "runuser: bad usage $*" >&2; exit 2; }; user=$2; shift 3; AS_USER=$user exec "$@"'
  # Health of whatever /opt/eje/app points at, unless that release is marked unhealthy.
  stub curl 'name=$(basename "$(readlink -f "$T/app")"); echo "curl $name" >> "$T/calls"
if [ -e "$T/unhealthy-$name" ]; then echo "{\"status\":\"degraded\",\"database\":\"unreachable\",\"build\":{\"commit\":\"$name\"}}"
else echo "{\"status\":\"ok\",\"backend\":\"postgres\",\"database\":\"reachable\",\"build\":{\"commit\":\"$name\"}}"; fi'
  stub systemctl 'echo "systemctl $*" >> "$T/calls"
case "$1" in restart) [ ! -e "$T/fail-restart" ];; is-active) [ ! -e "$T/inactive" ];; *) :;; esac'
  # systemd-run: the build, or an npm script as eje. Plays each outcome by marker.
  stub systemd-run 'all="$*"; dir=$(printf "%s\n" "$@" | sed -n "s/^--working-directory=//p")
case "$all" in
  *"git clone"*)
    echo "systemd-run build" >> "$T/calls"; [ -e "$T/fail-build" ] && exit 1
    mkdir -p "$dir/.next"; printf "%s\n" "$all" | grep -oE "detach [0-9a-f]{40}" | cut -d" " -f2 > "$dir/.sha";;
  *"npm run backup:verify"*) echo "systemd-run verify" >> "$T/calls"; [ ! -e "$T/fail-verify" ];;
  *"npm run backup:key-check"*) echo "systemd-run key-check" >> "$T/calls"; [ ! -e "$T/fail-keycheck" ];;
  *"npm run backup:restore-test"*)
    echo "systemd-run restore-test" >> "$T/calls"
    printf "%s\n" "$all" | grep -q "EnvironmentFile=$T/restore.env" || exit 9
    [ ! -e "$T/fail-restore" ];;
  *"npm run backup"*)
    echo "systemd-run backup" >> "$T/calls"; [ -e "$T/fail-backup" ] && exit 1
    echo "backup   written /var/backups/eje/eje-eje_production-2026-10-25T10-00-00Z";;
  *"npm run preflight"*)
    echo "systemd-run preflight" >> "$T/calls"
    if [ -e "$T/migrated" ]; then echo "[ ok ] Migrations         all 31 applied."
    elif [ -e "$T/two-pending" ]; then echo "[FAIL] Migrations         2 not applied: 0030_x, 0031_y. Run the migration before starting the application."
    else echo "[FAIL] Migrations         1 not applied: 0030_library_page_coverage_unknown. Run the migration before starting the application."; fi
    echo "[FAIL] Deployment target  the database is named eje_production; a demonstration deployment.  Accepted."
    [ -e "$T/extra-fail" ] && echo "[FAIL] Storage            /var/lib/eje/storage is not writable."
    echo "[ ok ] Database           reachable."; exit 1;;
  *"npm run db:migrate"*)
    # AS src/db/connection-guard.ts BEHAVES: a production database is refused,
    # before any connection, unless the intent names it.
    case "$all" in *"--setenv=EJE_PRODUCTION_MIGRATION=eje_production"*) ;;
      *) echo "systemd-run migrate REFUSED-NO-INTENT" >> "$T/calls"
         echo "This will change the schema of eje_production, which is the live database."; exit 1;; esac
    echo "systemd-run migrate" >> "$T/calls"; [ -e "$T/fail-migrate" ] && exit 1; touch "$T/migrated";;
  *) echo "systemd-run OTHER $all" >> "$T/calls";;
esac'
  export T
}
run() {
  PATH="$T/bin:$PATH" APP_LINK="$T/app" RELEASES="$T/releases" STATE_DIR="$T/state" \
    ENV_FILE="$T/eje.env" RESTORE_ENV="$T/restore.env" HEALTH_ATTEMPTS=3 \
    bash "$SCRIPT" "$@" > "$T/out" 2>&1
  echo $?
}
# What /opt/eje/app points at, read the same way in both link modes.
serving() { if [ -f "$T/app.link" ]; then basename "$(cat "$T/app.link")"; else basename "$(readlink -f "$T/app")"; fi; }
called() { grep -c "^$1" "$T/calls"; }
ok() { PASS=$((PASS+1)); printf 'ok   %s\n' "$1"; }
no() { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$1"; sed 's/^/     | /' "$T/out"; }
expect() { if [ "$2" = "$3" ] && { [ -z "${4:-}" ] || grep -qE -- "$4" "$T/out"; }; then ok "$1"; else no "$1 (exit $3, wanted $2${4:+, /$4/})"; fi; }
that() { if eval "$2"; then ok "$1"; else no "$1"; fi; }
untouched() { [ "$(serving)" = "$LIVE" ] && [ "$(called 'systemd-run migrate')" = 0 ] && [ "$(called 'systemctl restart')" = 0 ]; }

# ---- refusals before anything --------------------------------------------------
sandbox
expect "--check passes on a ready server, read only" 0 "$(run --check "$SHA")" 'CHECK PASSED'
that "...creates no release directory and runs nothing" "[ ! -e '$T/releases/$SHORT' ] && [ \$(called systemd-run) = 0 ] && untouched"
sandbox; echo some-other-host > "$T/hostname"
expect "refuses the wrong host" 1 "$(run --release "$SHA")" 'not srv2000625'
that "...nothing changed" "untouched && [ ! -e '$T/releases/$SHORT' ]"
sandbox
expect "refuses a short commit hash" 1 "$(run --release de0d9b6)" 'FULL 40-character'
sandbox; touch "$T/locked"
expect "refuses while another release command runs" 1 "$(run --release "$SHA")" 'another release command'
sandbox; touch "$T/unhealthy-$LIVE"
expect "refuses when the LIVE release is unhealthy before starting" 1 "$(run --release "$SHA")" 'not healthy now'
that "...nothing changed" "untouched && [ \$(called 'systemd-run build') = 0 ]"
sandbox; FREE=100 run --release "$SHA" > /dev/null
that "refuses with too little disk, nothing changed" "grep -q 'MB free under' '$T/out' && untouched && [ \$(called 'systemd-run build') = 0 ]"
sandbox; mkdir -p "$T/releases/$SHORT"; echo junk > "$T/releases/$SHORT/notes"
expect "refuses an existing release dir that is not a build of the commit" 1 "$(run --release "$SHA")" 'not a verified build'
that "...and leaves it exactly as it was" "[ -f '$T/releases/$SHORT/notes' ] && untouched"

# ---- the release ----------------------------------------------------------------
sandbox
expect "--release: builds, backs up, migrates, switches and proves health" 0 "$(run --release "$SHA")" "RELEASED: serving $SHORT"
that "...serving the new release" "[ \$(serving) = $SHORT ]"
that "...in the right ORDER: build, backup, verify, key check, restore test, preflight, migrate, preflight, restart" \
  "[ \"\$(grep -oE '^systemd-run (build|backup|verify|key-check|restore-test|preflight|migrate)|^systemctl restart' '$T/calls' | paste -sd,)\" = 'systemd-run build,systemd-run backup,systemd-run verify,systemd-run key-check,systemd-run restore-test,systemd-run preflight,systemd-run migrate,systemd-run preflight,systemctl restart' ]"
that "...records the rollback target and the proven backup" \
  "grep -q '^previous=$T/releases/$LIVE' '$T/state/release-$SHORT.state' && grep -q '^backup=/var/backups/eje/' '$T/state/release-$SHORT.state'"
that "...the restore test ran with the restore role's environment" "[ \$(called 'systemd-run restore-test') = 1 ]"

sandbox; mkdir -p "$T/releases/$SHORT/.next"; echo "$SHA" > "$T/releases/$SHORT/.sha"
expect "--release reuses a verified build of the same commit" 0 "$(run --release "$SHA")" 'reusing the verified build'
that "...without cloning again" "[ \$(called 'systemd-run build') = 0 ]"

# ---- the HEAD checks run as eje, never as root (the 25 October 2026 stop) --------
# A build the eje user made must be READ as eje: git refuses root in a repository
# it does not own, and that refusal read as "not a build of" the commit.
sandbox
run --release "$SHA" > /dev/null
that "after a fresh build, the HEAD check runs as eje and passes" \
  "grep -q 'RELEASED: serving $SHORT' '$T/out' && grep -q '^git eje -C $T/releases/$SHORT rev-parse HEAD' '$T/calls'"
that "...and git is never asked for HEAD as root" "[ \$(called 'git ROOT') = 0 ]"
sandbox; mkdir -p "$T/releases/$SHORT/.next"; echo "$SHA" > "$T/releases/$SHORT/.sha"
expect "--check recognises an eje-owned build of the commit (it will be reused)" 0 "$(run --check "$SHA")" 'holds a build of'
that "...without asking git as root" "[ \$(called 'git ROOT') = 0 ]"
sandbox; mkdir -p "$T/releases/$SHORT/.next"; echo "$SHA" > "$T/releases/$SHORT/.sha"
run --release "$SHA" > /dev/null
that "the reuse decision asks git as eje, never as root" \
  "grep -q 'reusing the verified build' '$T/out' && [ \$(called 'git ROOT') = 0 ] && [ \$(called 'git eje') -ge 1 ]"
that "every HEAD check in the script goes through release_head (static)" \
  "[ \$(grep -c 'git -C' '$SCRIPT') = 1 ] && grep -q '^release_head() { runuser -u eje -- git -C' '$SCRIPT'"

# ---- the migration carries the production intent, and nothing else does ---------
# The first live run (25 October 2026) stopped at 4/6: db:migrate refuses a
# production database unless EJE_PRODUCTION_MIGRATION names it, and the release
# did not pass it. The intent belongs to that ONE command, never to eje.env.
sandbox
run --release "$SHA" > /dev/null
that "the migration is given EJE_PRODUCTION_MIGRATION=eje_production, and applies" \
  "grep -q 'RELEASED: serving $SHORT' '$T/out' && [ \$(called 'systemd-run migrate REFUSED') = 0 ] && [ -e '$T/migrated' ]"
that "...and the intent is given to that one command only (static)" \
  "[ \$(grep -v '^ *#' '$SCRIPT' | grep -c 'EJE_PRODUCTION_MIGRATION=') = 1 ] && grep -v '^ *#' '$SCRIPT' | grep 'EJE_PRODUCTION_MIGRATION=' | grep -q 'npm run db:migrate'"

# ---- every gate before the migration stops with NOTHING changed -----------------
for case in fail-build fail-backup fail-verify fail-keycheck fail-restore two-pending extra-fail; do
  sandbox; touch "$T/$case"
  expect "$case: stops before the migration" 1 "$(run --release "$SHA")" 'STOPPED'
  that "...$case: live release still serving, no migration, no restart" "untouched"
done
sandbox; touch "$T/fail-migrate"
expect "a failed migration stops, and the live release keeps serving" 1 "$(run --release "$SHA")" 'still serving. Do not switch'
that "...no switch, no restart" "[ \$(serving) = $LIVE ] && [ \$(called 'systemctl restart') = 0 ]"

# ---- after the switch: automatic rollback where it can be proven -----------------
sandbox; touch "$T/unhealthy-$SHORT"
expect "an unhealthy new release is ROLLED BACK automatically" 1 "$(run --release "$SHA")" "ROLLED BACK: serving $LIVE"
that "...serving the previous release again, the failed build kept to inspect" "[ \$(serving) = $LIVE ] && [ -d '$T/releases/$SHORT/.next' ]"
that "...and says the migration stays (safe), never undoing it" "grep -q 'migration 0030 stays applied' '$T/out'"
# The live release becomes unhealthy only AFTER the migration — the case where
# the rollback itself cannot be proven.
sandbox; touch "$T/unhealthy-$SHORT"
cp "$T/bin/curl" "$T/bin/curl.real"
cat > "$T/bin/curl" <<'EOF'
#!/bin/bash
# Healthy for the pre-release check; after the migration, nothing is healthy.
if [ -e "$T/migrated" ]; then echo '{"status":"degraded","database":"unreachable"}'; else exec "$T/bin/curl.real" "$@"; fi
EOF
chmod +x "$T/bin/curl"
expect "if the rollback cannot be PROVEN healthy: exit 2, and it says a person decides" 2 "$(run --release "$SHA")" 'ROLLBACK NOT VERIFIED'

# ---- manual rollback --------------------------------------------------------------
sandbox; run --release "$SHA" > /dev/null
expect "--rollback returns to the recorded previous release" 0 "$(run --rollback)" "ROLLED BACK: serving $LIVE"
that "...serving it, and the database is not touched" "[ \$(serving) = $LIVE ] && [ \$(called 'systemd-run migrate') = 1 ] && grep -q 'THE DATABASE IS NOT TOUCHED' '$T/out'"
sandbox; mkdir -p "$T/releases/nonsense"
expect "--rollback refuses a target that is not a built release" 1 "$(run --rollback nonsense)" 'not a built release'
that "...nothing switched" "[ \$(serving) = $LIVE ] && [ \$(called 'systemctl restart') = 0 ]"

# ---- what it never does ---------------------------------------------------------------
that "never touches the firewall or SSH, and never deletes a release (static)" \
  "! grep -nE '(^|[^-])\\b(ufw|iptables|nft|sshd|rm -rf|rm -r )' '$SCRIPT' | grep -vE '^[0-9]+:\\s*#'"

sandbox
expect "--status is read only" 0 "$(run --status)" "serving:  $T/releases/$LIVE"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
