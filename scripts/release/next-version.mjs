#!/usr/bin/env node
/**
 * THE NEXT SEMANTIC VERSION OF EJE. VERSION-1 (the owner, 3 November 2026).
 *
 * Called by `deploy/release/deploy-release.sh` inside the release it is
 * building, so NOBODY picks a version by hand and no file has to be edited:
 *
 *   node scripts/release/next-version.mjs --previous <x.y.z|''> --from <live sha> --to <new sha>
 *
 * prints the version this release gets, e.g. `1.4.0`.
 *
 *   - THE STARTING POINT is `--previous`: the highest version the server has
 *     EVER recorded for a release (failed and rolled-back ones included), so a
 *     number is never handed out twice. With none recorded yet, the release is
 *     the first versioned one: 1.0.0.
 *   - HOW BIG A STEP comes from the commits since the release that is live,
 *     written in the Conventional Commits form this repository already uses:
 *       a `!` after the type (`feat!:`) or a "BREAKING CHANGE" note → MAJOR;
 *       a `feat` commit                                          → MINOR;
 *       anything else (`fix`, `style`, `test`, `docs`, `chore` …) → PATCH.
 *     `EJE_RELEASE_BUMP=major|minor|patch` may RAISE the step when a release is
 *     bigger than its commits say; it never lowers it.
 *   - Every release is a new version: with no commit to read (a re-release of
 *     the same code, or history that cannot be read) it is a PATCH.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const FIRST_VERSION = '1.0.0';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;
const ORDER = { patch: 0, minor: 1, major: 2 };

export const isVersion = (value) => typeof value === 'string' && SEMVER.test(value);

/** -1, 0 or 1. Non-versions sort below every version. */
export const compareVersions = (a, b) => {
  if (!isVersion(a)) return isVersion(b) ? -1 : 0;
  if (!isVersion(b)) return 1;
  const [x, y] = [a, b].map((value) => SEMVER.exec(value).slice(1).map(Number));
  for (let index = 0; index < 3; index += 1) {
    if (x[index] !== y[index]) return x[index] < y[index] ? -1 : 1;
  }
  return 0;
};

/** The highest version among these (anything else is ignored), or null. */
export const highestVersion = (values) =>
  values.filter(isVersion).reduce((best, value) => (best === null || compareVersions(value, best) > 0 ? value : best), null);

/** One commit message (subject, then body) → the step it asks for. */
export const bumpOfCommit = (message) => {
  const [subject = '', ...rest] = String(message).split('\n');
  const body = rest.join('\n');
  if (/^[a-z]+(\([^)]*\))?!:/u.test(subject) || /^BREAKING[ -]CHANGE:/mu.test(body)) return 'major';
  if (/^feat(\([^)]*\))?:/u.test(subject)) return 'minor';
  return 'patch';
};

/** The largest step any of these commits asks for; a PATCH when there are none. */
export const bumpOfCommits = (messages) =>
  messages.reduce((step, message) => (ORDER[bumpOfCommit(message)] > ORDER[step] ? bumpOfCommit(message) : step), 'patch');

/** Raise (never lower) a step by an operator's override. */
export const withOverride = (step, override) =>
  override in ORDER && ORDER[override] > ORDER[step] ? override : step;

/** The version after `previous` for this step; the first versioned release is FIRST_VERSION. */
export const nextVersion = (previous, step) => {
  if (!isVersion(previous)) return FIRST_VERSION;
  const [major, minor, patch] = SEMVER.exec(previous).slice(1).map(Number);
  if (step === 'major') return `${major + 1}.0.0`;
  if (step === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

/** The commit messages in `from..to`, or [] when that history cannot be read. */
const commitsBetween = (from, to) => {
  if (!/^[0-9a-f]{7,40}$/u.test(from ?? '') || !/^[0-9a-f]{7,40}$/u.test(to ?? '')) return [];
  try {
    const raw = execFileSync('git', ['log', '--format=%B%x00', `${from}..${to}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return raw.split('\0').map((message) => message.trim()).filter((message) => message.length > 0);
  } catch {
    return [];
  }
};

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? '' : (process.argv[at + 1] ?? '');
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const previous = argument('previous');
  const step = withOverride(bumpOfCommits(commitsBetween(argument('from'), argument('to'))), process.env.EJE_RELEASE_BUMP ?? '');
  process.stdout.write(`${nextVersion(previous, step)}\n`);
}
