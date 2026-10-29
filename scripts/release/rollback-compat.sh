#!/bin/bash
# ROLLBACK COMPATIBILITY: the live release (ef0f695) against a database this
# release has migrated to its newest migration (0039). First written for de0d9b6
# (25 October 2026, live 4634d5d, migration 0030); moved to the live ef0f695 and
# migrations 0037–0039 on 29 October 2026.
#
#   TEST_DATABASE_URL=postgres://…/eje_test bash scripts/release/rollback-compat.sh
#
# THE QUESTION. Migration 0030 cannot be "un-run" by switching the code back, so
# rolling back the release means the LIVE code meeting a database at 0030 —
# including the one row shape only the new code writes (partially indexed, page
# coverage unknown, 0 of M). This proves, with the live release's OWN code, that
# it reads, searches and writes that database, and that its preflight does not
# refuse it.
#
# HOW, AND WHY THIS WAY.
#   1. A temporary worktree of the live commit, removed on exit.
#   2. `node_modules` shared with this checkout — ONLY because the lockfile is
#      byte-identical between the two releases, which is checked first and is a
#      hard refusal if it is not true. Different dependencies would make the
#      result say nothing about the live server.
#   3. Phase 1 (THIS release): migrate a disposable TEST database to 0030 with
#      the real migrator and write every indexing state.
#   4. Phase 2 (LIVE release): its own repository, searchability wording and
#      preflight rule, against that database.
#
# ONLY A TEST DATABASE. `testDatabaseUrl()` refuses a URL whose database is not
# named as a test database, because phase 1 drops the schema. Nothing here can
# reach the VPS.
set -euo pipefail

LIVE=${LIVE_COMMIT:-ef0f695ac7121b4f10a0caced2c0be917309c3cb}
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL must name a disposable test database}"

root=$(git rev-parse --show-toplevel)
cd "$root"

if ! git cat-file -e "$LIVE^{commit}" 2>/dev/null; then
  echo "fetching the live commit $LIVE"
  git fetch --no-tags --depth=1 origin "$LIVE"
fi

if ! git diff --quiet "$LIVE" HEAD -- package-lock.json; then
  echo "REFUSED: package-lock.json differs between $LIVE and this release, so the live code"
  echo "cannot be run on these dependencies and the result would not describe the server."
  exit 1
fi

work=$(mktemp -d)
live="$work/live"
cleanup() {
  git -C "$root" worktree remove --force "$live" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

git worktree add --detach "$live" "$LIVE" >/dev/null 2>&1
ln -s "$root/node_modules" "$live/node_modules"
echo "live release checked out at $live ($(git -C "$live" rev-parse --short HEAD))"

# A phase PROVES something only if its tests RAN. A skipped test exits 0, so the
# exit code alone cannot tell "rollback compatible" from "ran nothing": each
# phase writes vitest's JSON report, and this refuses unless at least one test
# passed and none was skipped or failed.
run_phase() {
  local dir=$1 phase=$2 file=$3 report="$work/report-$2.json"
  (cd "$dir" && RELEASE_ROLLBACK_PHASE=$phase npx vitest run --config vitest.db.config.mts \
    --reporter=default --reporter=json --outputFile="$report" "$file") || {
    echo "REFUSED: phase '$phase' failed"; exit 1; }
  node -e '
    const r = require(process.argv[1]);
    const ran = r.numPassedTests, skipped = r.numPendingTests + r.numTodoTests, failed = r.numFailedTests;
    console.log(`phase ${process.argv[2]}: ${ran} passed, ${skipped} skipped, ${failed} failed`);
    if (ran === 0 || skipped > 0 || failed > 0) {
      console.log(`REFUSED: phase ${process.argv[2]} did not prove anything (every test must run and pass)`);
      process.exit(1);
    }' "$report" "$phase" || exit 1
}

echo
echo "=== phase 1 — THIS release migrates a disposable database to its newest migration and writes every state"
run_phase "$root" prepare src/ops/release/rollback-prepare.db.test.ts

echo
echo "=== phase 2 — the LIVE release's own code reads, searches and writes it"
mkdir -p "$live/src/release-probe"
cp scripts/release/rollback-probe.db.test.ts "$live/src/release-probe/"
run_phase "$live" probe src/release-probe/rollback-probe.db.test.ts

echo
echo "ROLLBACK COMPATIBLE: the live release ($LIVE) works against a database at this release's newest migration."
