#!/bin/bash
# EJE GUARDED RELEASE — build, back up, migrate, switch, prove; roll back where
# that is safe. Release readiness for de0d9b6, 25 October 2026; a release may
# carry several migrations (EXPECT_PENDING, in order) since the job-forms work.
#
#   bash deploy-release.sh --check   <full-sha>   read-only: is this server ready for that release?
#   bash deploy-release.sh --release <full-sha>   the whole release, every step gated
#   bash deploy-release.sh --rollback [<release>] back to the recorded previous release
#   bash deploy-release.sh --status               read-only: what is serving, what was recorded
#
# Run as root on the VPS. It is the commands in docs/deploy-next-release.md
# ("Release de0d9b6"), in that order, each one checked before the next runs.
#
# THE IRREVERSIBLE POINT, NAMED. Everything before the migration leaves the live
# release exactly as it was: the build goes into a NEW directory, the backup and
# the restore test only add files. The MIGRATION cannot be un-run by switching
# the code back — and does not need to be: `0030` only relaxes one CHECK and
# `0031` only adds a nullable column, and the live release's own code has been
# run against a database at both in CI (`scripts/release/rollback-compat.sh`).
# So:
#
#   build / backup / preflight fail  → STOP, nothing changed for anybody
#   migration fails                  → STOP, the old release is still serving
#   the switched release is unhealthy → AUTOMATIC ROLLBACK to the recorded
#                                       previous release, itself health-checked;
#                                       if THAT cannot be proven, a loud STOP and
#                                       no further action — a person decides
#
# WHAT IT NEVER DOES: touch the firewall, SSH, the database's data, a backup, or
# a release directory it did not create in this run. There is no "disable UFW"
# or "delete and retry" anywhere in it. It refuses to run twice at once (a lock),
# refuses the wrong host, refuses a short or malformed commit hash, and refuses a
# release directory that already exists unless it holds a verified build of the
# same commit.
set -u

MODE=${1:-}
SHA=${2:-}

# Everything a test, or a different server, may need to say differently.
EXPECT_HOST=${EXPECT_HOST:-srv2000625}
APP_LINK=${APP_LINK:-/opt/eje/app}
RELEASES=${RELEASES:-/opt/eje/releases}
STATE_DIR=${STATE_DIR:-/var/lib/eje-release}
ENV_FILE=${ENV_FILE:-/etc/eje/eje.env}
RESTORE_ENV=${RESTORE_ENV:-/etc/eje/restore-test.env}
REPO_URL=${REPO_URL:-https://github.com/VOID-za/EJE-Managment.git}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3000/api/health}
SERVICE=${SERVICE:-eje}
EXPECT_DB=${EXPECT_DB:-eje_production}
# THE MIGRATIONS THIS RELEASE IS EXPECTED TO APPLY, IN ORDER, comma-separated.
# Not "one": a release may carry several (this one carries 0030 and 0031), and
# the gate below demands the preflight's pending list be EXACTLY this list —
# same names, same count, same order — and that it be the newest entries of the
# release's own journal. Anything else stops the release before the migration.
# `-`, not `:-`: UNSET takes the default, but a value set to EMPTY is refused
# below rather than quietly replaced — an empty list typed by an operator is a
# mistake to stop on, not a request for the default.
EXPECT_PENDING=${EXPECT_PENDING-0030_library_page_coverage_unknown,0031_test_repair_date_received}
# The preflight FAILs the owner has accepted on this server, and nothing else.
ACCEPTED_FAILS=${ACCEPTED_FAILS:-Deployment target}
MIN_FREE_MB=${MIN_FREE_MB:-3000}
HEALTH_ATTEMPTS=${HEALTH_ATTEMPTS:-30}
HEALTH_PAUSE=${HEALTH_PAUSE:-2}
TAG=eje-release

say() { printf '%s\n' "$*"; logger -t "$TAG" -- "$*" 2>/dev/null || true; }
stop() { say "STOPPED: $*"; exit 1; }

case "$MODE" in --check|--release|--rollback|--status) ;; *) stop "say --check <sha>, --release <sha>, --rollback [<release>] or --status";; esac

# The expected list must be well-formed before anything is looked at: migration
# tags, no duplicates, strictly ascending. A malformed list is a typo in the
# operator's command, and acting on it would compare against the wrong thing.
expected_pending_problem() {
  local previous='' tag
  [ -n "$EXPECT_PENDING" ] || { echo 'EXPECT_PENDING is empty'; return; }
  case "$EXPECT_PENDING" in *' '*|,*|*,|*,,*) echo "EXPECT_PENDING must be tags separated by single commas: $EXPECT_PENDING"; return;; esac
  for tag in ${EXPECT_PENDING//,/ }; do
    printf '%s' "$tag" | grep -qE '^[0-9]{4}_[a-z0-9_]+$' || { echo "not a migration tag: $tag"; return; }
    if [ -n "$previous" ] && ! [[ "$tag" > "$previous" ]]; then echo "out of order or repeated: $previous then $tag"; return; fi
    previous=$tag
  done
}
if [ "$MODE" = --check ] || [ "$MODE" = --release ]; then
  problem=$(expected_pending_problem)
  [ -z "$problem" ] || stop "$problem. Nothing was changed."
fi
[ "$(id -u)" -eq 0 ] || stop "run as root"

# ---- facts ---------------------------------------------------------------------
live_target() { readlink -f "$APP_LINK" 2>/dev/null; }
health() { curl -s -m 10 "$HEALTH_URL" 2>/dev/null; }
field() { printf '%s' "$1" | grep -oE "\"$2\":\"[^\"]*\"" | head -1 | sed -E 's/.*:"([^"]*)"/\1/'; }
# Healthy AND serving the expected commit AND the database reachable — all three.
healthy_as() {
  local want=$1 body
  body=$(health)
  [ "$(field "$body" status)" = ok ] && [ "$(field "$body" commit)" = "$want" ] \
    && [ "$(field "$body" database)" = reachable ]
}
wait_healthy_as() {
  local want=$1 attempt
  for attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
    healthy_as "$want" && return 0
    sleep "$HEALTH_PAUSE"
  done
  return 1
}
# An npm script, as eje, with the service's own environment — the form the
# runbook calls "as eje". The working directory is the release being acted on.
as_eje() {
  local dir=$1; shift
  systemd-run --quiet --collect --pipe --wait --uid=eje --gid=eje \
    --working-directory="$dir" -p PrivateTmp=yes \
    --property=EnvironmentFile="$ENV_FILE" --setenv=HOME=/opt/eje "$@"
}
# THE RELEASE DIRECTORY BELONGS TO eje, which cloned and built it. Since git
# 2.35.2 git refuses to work in a repository another user owns ("detected
# dubious ownership") — root included — and the refusal went to /dev/null, so a
# good build read as "not a build of" the commit. Every HEAD check therefore
# runs as the directory's owner.
release_head() { runuser -u eje -- git -C "$1" rev-parse HEAD 2>/dev/null; }
state_file() { printf '%s/release-%s.state' "$STATE_DIR" "$1"; }
record() { printf '%s=%s\n' "$2" "$3" >> "$(state_file "$1")"; }
recorded() { sed -n "s/^$2=//p" "$(state_file "$1")" 2>/dev/null | tail -1; }

if [ "$MODE" = --status ]; then
  say "serving:  $(live_target)"
  say "health:   $(health | cut -c1-240)"
  for file in "$STATE_DIR"/release-*.state; do
    [ -f "$file" ] && say "record:   $(basename "$file"): $(tr '\n' ' ' < "$file")"
  done
  exit 0
fi

# ---- every mode below acts on one server, one at a time --------------------------
[ "$(hostname)" = "$EXPECT_HOST" ] || stop "this is $(hostname), not $EXPECT_HOST"
install -d -m 700 "$STATE_DIR"
exec 9>"$STATE_DIR/lock"
flock -n 9 || stop "another release command is running (lock $STATE_DIR/lock)"

# ---- rollback --------------------------------------------------------------------
switch_to() {
  local target=$1
  ln -sfn "$target" "$APP_LINK.new" && mv -T "$APP_LINK.new" "$APP_LINK" && systemctl restart "$SERVICE"
}
if [ "$MODE" = --rollback ]; then
  current=$(live_target)
  target=${SHA:+$RELEASES/$SHA}
  if [ -z "$target" ]; then
    short=$(basename "$current")
    target=$(recorded "$short" previous)
  fi
  [ -n "$target" ] || stop "no rollback target: name one (e.g. --rollback 4634d5d) or run from a recorded release"
  [ -d "$target/.next" ] || stop "$target is not a built release (no .next) — refusing to switch to it"
  want=$(basename "$target")
  say "rolling back: $current -> $target"
  say "THE DATABASE IS NOT TOUCHED. Migration 0030 stays applied; the live release reads and writes a database at 0030 (proven in CI by rollback-compat.sh)."
  switch_to "$target" || stop "the switch to $target failed — check $APP_LINK by hand"
  wait_healthy_as "$want" || stop "ROLLBACK NOT VERIFIED: $target is linked but /api/health does not report $want with the database reachable. Do not retry; a person decides."
  say "ROLLED BACK: serving $want, healthy, database reachable."
  exit 0
fi

# ---- --check and --release need a full commit hash ------------------------------
printf '%s' "$SHA" | grep -qE '^[0-9a-f]{40}$' || stop "give the FULL 40-character commit hash, not '$SHA'"
SHORT=${SHA:0:7}
RELEASE="$RELEASES/$SHORT"
LIVE=$(live_target)

# ---- the read-only check: the same gates --release applies before it changes anything
check() {
  local problems=0 free
  say "host:          $(hostname)"
  say "serving now:   $LIVE"
  if [ "$LIVE" = "$RELEASE" ]; then say "PROBLEM: $SHORT is already serving"; problems=1; fi
  if healthy_as "$(basename "$LIVE")"; then say "health:        ok, $(basename "$LIVE"), database reachable"
  else say "PROBLEM: the live release is not healthy now — a release would start from an unknown state"; problems=1; fi
  if [ -e "$RELEASE" ]; then
    if [ -d "$RELEASE/.next" ] && [ "$(release_head "$RELEASE")" = "$SHA" ]; then
      say "release dir:   $RELEASE exists and holds a build of $SHORT (it will be reused)"
    else say "PROBLEM: $RELEASE exists and is not a verified build of $SHA — inspect it; it is not touched"; problems=1; fi
  else say "release dir:   $RELEASE (new)"; fi
  free=$(df -Pm "$RELEASES" 2>/dev/null | awk 'NR==2 {print $4}')
  if [ "${free:-0}" -ge "$MIN_FREE_MB" ]; then say "disk:          ${free} MB free"
  else say "PROBLEM: ${free:-?} MB free under $RELEASES, need $MIN_FREE_MB"; problems=1; fi
  for binary in pdftotext pdfinfo; do
    if command -v "$binary" >/dev/null; then say "$binary:  $(command -v "$binary")"
    else say "WARNING: $binary (poppler-utils) is missing — the library falls back to the built-in reader"; fi
  done
  [ -r "$ENV_FILE" ] || { say "PROBLEM: $ENV_FILE is not readable"; problems=1; }
  [ -r "$RESTORE_ENV" ] || { say "PROBLEM: $RESTORE_ENV (the restore-test role) is not readable"; problems=1; }
  systemctl is-active --quiet "$SERVICE" || { say "PROBLEM: $SERVICE is not active"; problems=1; }
  return $problems
}

if [ "$MODE" = --check ]; then
  if check; then say ""; say "CHECK PASSED — read only, nothing was changed."; exit 0; fi
  say ""; say "CHECK FAILED (above) — read only, nothing was changed."; exit 1
fi

# ---- --release -------------------------------------------------------------------
check || stop "the read-only check failed (above). Nothing was changed."
: > "$(state_file "$SHORT")"
record "$SHORT" previous "$LIVE"
record "$SHORT" started "$(date -u +%FT%TZ)"
say "release $SHA; the rollback target is $LIVE"

# 1. BUILD, beside the live release. Never in /opt/eje/app.
if [ -d "$RELEASE/.next" ] && [ "$(release_head "$RELEASE")" = "$SHA" ]; then
  say "1/6 build: reusing the verified build in $RELEASE"
else
  install -d -o eje -g eje "$RELEASE" || stop "could not create $RELEASE. Nothing else was changed."
  say "1/6 build: cloning and building $SHA in $RELEASE (the live release keeps serving)"
  systemd-run --quiet --collect --pipe --wait --uid=eje --gid=eje \
    --working-directory="$RELEASE" -p MemoryMax=4G -p Nice=10 -p CPUWeight=20 -p PrivateTmp=yes \
    --setenv=HOME=/opt/eje --setenv=EJE_BUILD_COMMIT="$SHORT" \
    /bin/bash -c "set -eo pipefail
      git clone --quiet --no-checkout $REPO_URL .
      git checkout --quiet --detach $SHA
      test \"\$(git rev-parse HEAD)\" = $SHA
      npm ci --no-audit --no-fund
      npm run build" \
    || stop "the build failed in $RELEASE (left there to inspect). The live release was not touched."
  [ "$(release_head "$RELEASE")" = "$SHA" ] && [ -d "$RELEASE/.next" ] \
    || stop "the build finished but $RELEASE is not a build of $SHA. The live release was not touched."
fi
record "$SHORT" built yes

# 2. BACK UP, WITH THE NEW CODE, AND PROVE THE BACKUP RESTORES.
say "2/6 backup: backup, verify, key check, restore test"
as_eje "$RELEASE" /usr/bin/npm run backup > "$STATE_DIR/backup-$SHORT.log" 2>&1 \
  || stop "the backup failed ($STATE_DIR/backup-$SHORT.log). Nothing was changed."
backup=$(grep -oE '/var/backups/eje/[^ ]+' "$STATE_DIR/backup-$SHORT.log" | tail -1)
[ -n "$backup" ] || stop "the backup reported no path ($STATE_DIR/backup-$SHORT.log). Nothing was changed."
as_eje "$RELEASE" /usr/bin/npm run backup:verify -- "$backup" >> "$STATE_DIR/backup-$SHORT.log" 2>&1 \
  || stop "the backup did not verify: $backup. Nothing was changed."
as_eje "$RELEASE" /usr/bin/npm run backup:key-check -- "$backup" >> "$STATE_DIR/backup-$SHORT.log" 2>&1 \
  || stop "the key held is not the key this backup needs: $backup. Nothing was changed."
systemd-run --quiet --collect --pipe --wait --uid=eje --gid=eje \
  --working-directory="$RELEASE" -p PrivateTmp=yes \
  --property=EnvironmentFile="$ENV_FILE" --property=EnvironmentFile="$RESTORE_ENV" --setenv=HOME=/opt/eje \
  /usr/bin/npm run backup:restore-test -- "$backup" >> "$STATE_DIR/backup-$SHORT.log" 2>&1 \
  || stop "the restore test failed for $backup. Nothing was changed."
record "$SHORT" backup "$backup"
say "    backup proven: $backup"

# 3. PREFLIGHT: exactly the expected migrations pending, in order, and no FAIL but the accepted ones.
preflight() { as_eje "$RELEASE" /usr/bin/npm run preflight -- --expect-db "$EXPECT_DB" 2>&1; }
unexpected_fails() {
  # preflight prints `[FAIL] <name padded>  <detail>`: the name is everything up
  # to the first run of two or more spaces.
  printf '%s\n' "$1" | grep -E '^\[FAIL\] ' | awk -F '  +' '{ sub(/^\[FAIL\] /, "", $1); print $1 }' | while read -r name; do
    case ",$ACCEPTED_FAILS,$2," in *",$name,"*) ;; *) printf '%s\n' "$name";; esac
  done
}
# THE RELEASE'S OWN JOURNAL is the reference for order and count: the tags it
# ships, oldest first. Read from the file, not from anything the operator typed.
journal_tags() {
  grep -oE '"tag": *"[0-9]{4}_[a-z0-9_]+"' "$RELEASE/src/db/migrations/meta/_journal.json" 2>/dev/null \
    | sed -E 's/.*"([^"]+)"$/\1/'
}
shipped_tags=$(journal_tags)
shipped=$(printf '%s\n' "$shipped_tags" | grep -c .)
[ "$shipped" -gt 0 ] || stop "the release's migration journal could not be read ($RELEASE/src/db/migrations/meta/_journal.json). Nothing was changed."
expected_count=$(printf '%s\n' "${EXPECT_PENDING//,/ }" | wc -w | tr -d ' ')
newest=$(printf '%s\n' "$shipped_tags" | tail -n "$expected_count" | paste -sd, -)
[ "$newest" = "$EXPECT_PENDING" ] \
  || stop "the expected migrations ($EXPECT_PENDING) are not the newest $expected_count this release ships ($newest). Nothing was changed."

say "3/6 preflight before the migration: expecting $expected_count pending, in order: $EXPECT_PENDING"
before=$(preflight)
printf '%s\n' "$before" > "$STATE_DIR/preflight-before-$SHORT.log"
# `[FAIL] Migrations   <n> not applied: <a>, <b>. Run the migration ...` — the
# count and the list, both compared exactly: two pending when one was expected,
# the right two in the wrong order, or none at all, is a STOP.
pending=$(printf '%s\n' "$before" | grep -E '^\[FAIL\] Migrations ' | head -1 \
  | sed -nE 's/^\[FAIL\] Migrations +([0-9]+) not applied: (.*)\. Run the migration.*$/\1|\2/p')
pending_count=${pending%%|*}
pending_list=${pending#*|}
pending_list=${pending_list//, /,}
[ -n "$pending" ] && [ "$pending_count" = "$expected_count" ] && [ "$pending_list" = "$EXPECT_PENDING" ] \
  || stop "preflight does not show exactly the expected pending migrations, in order ($EXPECT_PENDING) — see $STATE_DIR/preflight-before-$SHORT.log. Nothing was changed."
extra=$(unexpected_fails "$before" Migrations)
[ -z "$extra" ] || stop "preflight FAILs not accepted for this server: $(printf '%s' "$extra" | paste -sd,). Nothing was changed."

# 4. MIGRATE. The one step that is not reversed — and need not be (see the header).
say "4/6 migrate: applying $EXPECT_PENDING in order (the live release keeps serving; it reads a database at these migrations)"
# WITH THE PRODUCTION-MIGRATION INTENT, as runbook §5 types it. `npm run
# db:migrate` refuses a database that names itself production unless
# EJE_PRODUCTION_MIGRATION names it too (src/db/connection-guard.ts) — before it
# connects — and the intent must never sit in eje.env, so it is given to this one
# command and nothing else. Without it the first live run stopped here, with the
# database untouched (25 October 2026).
as_eje "$RELEASE" --setenv=EJE_PRODUCTION_MIGRATION="$EXPECT_DB" /usr/bin/npm run db:migrate \
  > "$STATE_DIR/migrate-$SHORT.log" 2>&1 \
  || stop "the migration failed ($STATE_DIR/migrate-$SHORT.log). The live release $LIVE is still serving. Do not switch."
record "$SHORT" migrated yes
after=$(preflight)
printf '%s\n' "$after" > "$STATE_DIR/preflight-after-$SHORT.log"
# ALL of them, counted against the journal: `all <shipped> applied`, not merely
# "some number applied" — a migrator that stopped part-way through a
# multi-migration release would still read "all N" for a smaller N.
printf '%s\n' "$after" | grep -qE "^\[ ok \] Migrations +all $shipped applied\." \
  || stop "after the migration, preflight does not show all $shipped migrations applied ($STATE_DIR/preflight-after-$SHORT.log). The live release is still serving. Do not switch."
extra=$(unexpected_fails "$after" '')
[ -z "$extra" ] || stop "after the migration, preflight FAILs not accepted: $(printf '%s' "$extra" | paste -sd,). The live release is still serving."

# 5. SWITCH, ATOMICALLY, AND PROVE WHAT IS SERVING.
say "5/6 switch: $LIVE -> $RELEASE"
record "$SHORT" switched "$(date -u +%FT%TZ)"
if ! switch_to "$RELEASE"; then
  say "the switch failed part-way — returning to $LIVE"
  switch_to "$LIVE" && wait_healthy_as "$(basename "$LIVE")" \
    && stop "the switch failed; ROLLED BACK to $(basename "$LIVE"), healthy. Migration 0030 stays applied (safe)."
  say "ROLLBACK NOT VERIFIED after a failed switch. Do not retry; a person decides."; exit 2
fi

# 6. THE HEALTH GATE — and automatic rollback if it does not pass.
say "6/6 health: waiting for $SHORT, status ok, database reachable"
if wait_healthy_as "$SHORT"; then
  record "$SHORT" healthy "$(date -u +%FT%TZ)"
  say ""
  say "RELEASED: serving $SHORT, healthy, database reachable. The previous release $(basename "$LIVE") is kept as the rollback target:"
  say "  bash deploy-release.sh --rollback"
  exit 0
fi

say "the new release is NOT healthy: $(health | cut -c1-240)"
say "AUTOMATIC ROLLBACK to $LIVE (migration 0030 stays applied — the live release reads it)"
record "$SHORT" rollback "$(date -u +%FT%TZ)"
if switch_to "$LIVE" && wait_healthy_as "$(basename "$LIVE")"; then
  say "ROLLED BACK: serving $(basename "$LIVE"), healthy, database reachable. The failed build stays in $RELEASE to inspect."
  exit 1
fi
say "ROLLBACK NOT VERIFIED: $(basename "$LIVE") is linked but not proven healthy. Do not retry; a person decides."
exit 2
