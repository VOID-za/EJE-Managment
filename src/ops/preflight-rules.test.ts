import { describe, expect, it } from 'vitest';
import {
  checkBackend,
  checkBackupKey,
  checkDatabaseTarget,
  checkDemoSwitcher,
  checkEmail,
  checkExportAudit,
  checkMigrations,
  checkOffsiteBackup,
  checkPdfTextEngine,
  checkTextRecognition,
  checkRuntime,
  checkStorage,
  checkCustomerSites,
  passed,
  type Check,
} from './preflight-rules';

/**
 * WOULD THIS MACHINE SERVE EJE? ARCH-5, MANDATE-3.
 *
 * `npm run preflight` is what an operator runs before `systemctl start`, and
 * every rule it applies is here, pure, so the refusals can be proved without a
 * machine, a database or a deployment.
 *
 * TWO PROPERTIES MATTER MORE THAN THE INDIVIDUAL RULES, and both are asserted
 * across every check: a failure is a REFUSAL (the command exits non-zero, so a
 * deployment script stops), and **no verdict ever contains a configured value**
 * — the output of this command gets pasted into messages.
 */

const SECRETS = {
  DATABASE_URL: 'postgresql://eje_app:hunter2-the-real-password@localhost:5432/eje_production',
  EJE_BACKUP_KEY: 'a'.repeat(64),
  EMAIL_GRAPH_CLIENT_SECRET: 'graph-client-secret-value',
  WHATSAPP_ACCESS_TOKEN: 'whatsapp-access-token-value',
} as const;

const printed = (checks: readonly Check[]): string =>
  checks.map((check) => `${check.name} ${check.detail}`).join('\n');

describe('the backend a deployment would actually use', () => {
  /*
   * THE SILENT FAILURE THIS COMMAND EXISTS FOR. An absent DATABASE_URL is not
   * an error at startup: it is the in-memory demonstration store, serving
   * fictional customers and discarding every write on restart.
   */
  it('REFUSES a deployment with no database', () => {
    const checks = checkBackend({ EJE_PERSISTENCE: 'postgres' });
    expect(passed(checks)).toBe(false);
    expect(printed(checks)).toMatch(/DEMONSTRATION store/u);
  });

  it('REFUSES a deployment that names the demonstration backend', () => {
    const checks = checkBackend({ EJE_PERSISTENCE: 'demo', DATABASE_URL: SECRETS.DATABASE_URL });
    expect(passed(checks)).toBe(false);
  });

  it('warns when the backend is inferred rather than named', () => {
    const checks = checkBackend({ DATABASE_URL: SECRETS.DATABASE_URL });
    expect(passed(checks)).toBe(true);
    expect(checks.some((check) => check.verdict === 'warn')).toBe(true);
  });

  it('accepts postgres named out loud', () => {
    const checks = checkBackend({
      EJE_PERSISTENCE: 'postgres',
      DATABASE_URL: SECRETS.DATABASE_URL,
    });
    expect(checks.every((check) => check.verdict === 'ok')).toBe(true);
  });
});

describe('the database a service is about to write to', () => {
  /**
   * THE STAGING GUARD. Nothing in a connection string says which deployment it
   * belongs to, so a staging unit started with production's environment file is
   * indistinguishable from a correct one — until it writes.
   */
  it('REFUSES a database that is not the one this deployment expects', () => {
    const checks = checkDatabaseTarget({ DATABASE_URL: SECRETS.DATABASE_URL }, 'eje_staging');
    expect(passed(checks)).toBe(false);
    expect(printed(checks)).toMatch(/expects "eje_staging" and is configured for "eje_production"/u);
  });

  it('accepts the database it was told to expect, and names it', () => {
    const checks = checkDatabaseTarget({ DATABASE_URL: SECRETS.DATABASE_URL }, 'eje_production');
    expect(passed(checks)).toBe(true);
    expect(printed(checks)).toContain('eje_production');
  });

  it('says nothing about the credentials in the connection string', () => {
    const checks = checkDatabaseTarget({ DATABASE_URL: SECRETS.DATABASE_URL }, null);
    expect(printed(checks)).not.toContain('hunter2-the-real-password');
    expect(printed(checks)).not.toContain('eje_app');
  });

  it('REFUSES a connection string that names no database', () => {
    const checks = checkDatabaseTarget({ DATABASE_URL: 'not a url at all' }, null);
    expect(passed(checks)).toBe(false);
    expect(printed(checks)).not.toContain('not a url at all');
  });
});

describe('whether the schema is up to date', () => {
  const SHIPPED = ['0000_initial', '0001_numbering', '0002_immutability'];

  it('REFUSES a database behind the repository, and names the missing migrations', () => {
    const checks = checkMigrations(SHIPPED, { applied: 1, schemaPresent: true });
    expect(passed(checks)).toBe(false);
    expect(printed(checks)).toMatch(/0001_numbering, 0002_immutability/u);
  });

  it('accepts a database that has run them all', () => {
    expect(passed(checkMigrations(SHIPPED, { applied: 3, schemaPresent: true }))).toBe(true);
  });

  /*
   * THE DISTINCTION THE FIRST DRAFT GOT WRONG. A restored dump carries the
   * tables and not drizzle's ledger, and so does a database built by the test
   * harness — reporting "three migrations not applied" there is alarming and
   * false. It is a warning about the LEDGER, not a refusal of the schema.
   */
  it('tells an empty ledger with a real schema apart from an unmigrated database', () => {
    const restored = checkMigrations(SHIPPED, { applied: 0, schemaPresent: true });
    expect(passed(restored)).toBe(true);
    expect(restored[0]?.verdict).toBe('warn');
    expect(printed(restored)).toMatch(/restored dump, or a test harness/u);

    const empty = checkMigrations(SHIPPED, { applied: 0, schemaPresent: false });
    expect(passed(empty)).toBe(false);
  });

  it('REFUSES when the ledger cannot be read at all', () => {
    const checks = checkMigrations(SHIPPED, { applied: null, schemaPresent: true });
    expect(passed(checks)).toBe(false);
    expect(printed(checks)).toMatch(/impossible to say/u);
  });
});

describe('customers still recorded with several sites (SITE-1)', () => {
  it('reports legacy customers as a warning, never a failure', () => {
    const checks = checkCustomerSites(4);
    expect(checks[0]?.verdict).toBe('warn');
    expect(checks[0]?.detail).toContain('4 customer(s)');
    expect(passed(checks)).toBe(true);
  });

  it('says when the one-site constraint can be added', () => {
    expect(checkCustomerSites(0)[0]).toMatchObject({ verdict: 'ok' });
    expect(checkCustomerSites(0)[0]?.detail).toContain('constraint can be added');
  });

  it('says plainly when it could not count', () => {
    expect(checkCustomerSites(null)[0]?.verdict).toBe('warn');
  });
});

describe('where the documents go', () => {
  const facts = {
    configured: '/var/lib/eje/storage',
    exists: true,
    writable: true,
    insideApplication: false,
  };

  it('accepts a directory that exists and can be written', () => {
    expect(passed(checkStorage(facts))).toBe(true);
  });

  it('REFUSES an unset storage directory', () => {
    expect(passed(checkStorage({ ...facts, configured: '' }))).toBe(false);
  });

  it('REFUSES a directory this user cannot write to', () => {
    const checks = checkStorage({ ...facts, writable: false });
    expect(passed(checks)).toBe(false);
    expect(printed(checks)).toMatch(/every issued document would fail/iu);
  });

  /*
   * THE ONE NOBODY EXPECTS. A storage directory inside the application
   * directory is deleted by the next deployment, taking every signed job card
   * with it — and a backup of the database alone cannot rebuild one (CR-01).
   */
  it('REFUSES a storage directory inside the application directory', () => {
    const checks = checkStorage({ ...facts, insideApplication: true });
    expect(passed(checks)).toBe(false);
    expect(printed(checks)).toMatch(/next deployment replaces that directory/u);
  });
});

describe('the backup key', () => {
  it('warns when there is none, because only backups are affected', () => {
    const checks = checkBackupKey({});
    expect(passed(checks)).toBe(true);
    expect(checks[0]?.verdict).toBe('warn');
  });

  it('REFUSES a key of the wrong shape, which would refuse every backup', () => {
    expect(passed(checkBackupKey({ EJE_BACKUP_KEY: 'a-passphrase' }))).toBe(false);
  });

  it('never prints the key, nor its length', () => {
    const checks = checkBackupKey({ EJE_BACKUP_KEY: SECRETS.EJE_BACKUP_KEY });
    expect(passed(checks)).toBe(true);
    expect(printed(checks)).not.toContain(SECRETS.EJE_BACKUP_KEY);
    expect(printed(checks)).not.toContain('64');
  });
});

describe('whether a customer could be sent their job card', () => {
  it('REFUSES a real-database deployment that cannot send at all', () => {
    const checks = checkEmail({ NODE_ENV: 'production' }, false);
    expect(passed(checks)).toBe(false);
    // By variable NAME, which is what an operator needs.
    expect(printed(checks)).toMatch(/EMAIL_GRAPH_CLIENT_SECRET/u);
  });

  it('accepts a configured Microsoft 365 deployment without quoting the secret', () => {
    const checks = checkEmail(
      {
        NODE_ENV: 'production',
        EMAIL_GRAPH_TENANT_ID: 'tenant',
        EMAIL_GRAPH_CLIENT_ID: 'client',
        EMAIL_GRAPH_CLIENT_SECRET: SECRETS.EMAIL_GRAPH_CLIENT_SECRET,
        EMAIL_SENDER: 'jobcards@eje.example',
      },
      false,
    );
    expect(passed(checks)).toBe(true);
    expect(printed(checks)).not.toContain(SECRETS.EMAIL_GRAPH_CLIENT_SECRET);
  });

  it('warns rather than refuses on a demonstration deployment', () => {
    const checks = checkEmail({ NODE_ENV: 'production' }, true);
    expect(passed(checks)).toBe(true);
    expect(printed(checks)).toMatch(/demonstration outbox/u);
  });

  it('warns about a configuration that is complete and still wrong', () => {
    const checks = checkEmail(
      {
        NODE_ENV: 'production',
        EMAIL_GRAPH_TENANT_ID: 'tenant',
        EMAIL_GRAPH_CLIENT_ID: 'client',
        EMAIL_GRAPH_CLIENT_SECRET: 'secret',
        EMAIL_SENDER: 'EJE Job Cards',
      },
      false,
    );
    expect(printed(checks)).toMatch(/EMAIL_SENDER is not an address/u);
  });
});

describe('the demonstration sign-in switch', () => {
  /**
   * The one setting that can turn a real deployment into a public one: it signs
   * anybody in as the seeded accounts whose password is in the documentation.
   * It is armed only when its value NAMES the configured database, so the two
   * are compared rather than the word being read.
   */
  it('REFUSES a deployment where it is armed', () => {
    const checks = checkDemoSwitcher({
      DATABASE_URL: SECRETS.DATABASE_URL,
      EJE_DEMO_SWITCHER: 'eje_production',
    });
    expect(passed(checks)).toBe(false);
    expect(printed(checks)).toMatch(/ARMED/u);
  });

  it('warns when it is set and inert', () => {
    const checks = checkDemoSwitcher({
      DATABASE_URL: SECRETS.DATABASE_URL,
      EJE_DEMO_SWITCHER: 'some_other_database',
    });
    expect(passed(checks)).toBe(true);
    expect(checks[0]?.verdict).toBe('warn');
  });

  it('is quiet when it is absent', () => {
    expect(checkDemoSwitcher({ DATABASE_URL: SECRETS.DATABASE_URL })[0]?.verdict).toBe('ok');
  });
});

describe('the process and the build it would serve', () => {
  it('REFUSES to start without built output', () => {
    const checks = checkRuntime(
      { NODE_ENV: 'production' },
      { buildPresent: false, buildCommit: '' },
    );
    expect(passed(checks)).toBe(false);
  });

  it('reports the commit stamp, which is not a secret and is the point', () => {
    const checks = checkRuntime(
      { NODE_ENV: 'production', EJE_BUILD_COMMIT: '3f0d32e' },
      { buildPresent: true, buildCommit: '3f0d32e' },
    );
    expect(passed(checks)).toBe(true);
    expect(printed(checks)).toContain('3f0d32e');
  });

  it('warns about a deployment that is not production', () => {
    const checks = checkRuntime({}, { buildPresent: true, buildCommit: 'abc1234' });
    expect(passed(checks)).toBe(true);
    expect(checks.some((check) => check.verdict === 'warn')).toBe(true);
  });
});

/**
 * THE PROPERTY THAT HOLDS ACROSS EVERYTHING: a preflight report can be pasted
 * into a message. Every rule is run against a configuration made entirely of
 * secrets, and none of them may appear.
 */
describe('nothing printed is ever a configured value', () => {
  it('keeps every secret out of the whole report', () => {
    const env = {
      NODE_ENV: 'production',
      EJE_PERSISTENCE: 'postgres',
      ...SECRETS,
      EJE_STORAGE_DIR: '/var/lib/eje/storage',
      EJE_DEMO_SWITCHER: 'eje_production',
      WHATSAPP_PHONE_NUMBER_ID: '123456789',
      EMAIL_GRAPH_TENANT_ID: 'tenant-id-value',
      EMAIL_GRAPH_CLIENT_ID: 'client-id-value',
      EMAIL_SENDER: 'jobcards@eje.example',
    };

    const everything = [
      ...checkRuntime(env, { buildPresent: true, buildCommit: 'abc1234' }),
      ...checkBackend(env),
      ...checkDatabaseTarget(env, 'eje_production'),
      ...checkMigrations(['0000_initial'], { applied: 1, schemaPresent: true }),
      ...checkStorage({
        configured: env.EJE_STORAGE_DIR,
        exists: true,
        writable: true,
        insideApplication: false,
      }),
      ...checkBackupKey(env),
      ...checkEmail(env, false),
      ...checkDemoSwitcher(env),
    ];

    const report = printed(everything);
    for (const secret of [
      SECRETS.EJE_BACKUP_KEY,
      SECRETS.EMAIL_GRAPH_CLIENT_SECRET,
      SECRETS.WHATSAPP_ACCESS_TOKEN,
      'hunter2-the-real-password',
      SECRETS.DATABASE_URL,
    ]) {
      expect(report, secret.slice(0, 12)).not.toContain(secret);
    }
  });
});

describe('the three things the last deployment pass could not see', () => {
  /**
   * EACH OF THESE IS A DEPLOYMENT THAT LOOKS FINE AND IS NOT.
   *
   * The preflight exists to catch exactly that, and what it could not see
   * before was: a backup that only exists on the machine it is a backup of, a
   * text-recognition engine somebody believes is on, and monitoring of EJE's
   * own staff switched on without anybody saying so.
   */
  it('WARNS when a backup would exist only on this machine', () => {
    const [check] = checkOffsiteBackup({});
    expect(check?.verdict).toBe('warn');
    // It names both remedies, because which one EJE have is not ours to guess.
    expect(check?.detail).toMatch(/EJE_BACKUP_OFFSITE_DIR/u);
    expect(check?.detail).toMatch(/EJE_BACKUP_OFFSITE_RCLONE/u);
  });

  it('is satisfied by either destination, and names NEITHER value', () => {
    /*
     * A WARNING, not a failure: a deployment can legitimately run for a day
     * without one while somebody arranges it, and a check that refused to
     * start the service over it is a check people learn to bypass.
     */
    const volume = checkOffsiteBackup({ EJE_BACKUP_OFFSITE_DIR: '/mnt/eje-offsite' });
    expect(volume[0]?.verdict).toBe('ok');
    expect(volume[0]?.detail).not.toContain('/mnt/eje-offsite');

    const remote = checkOffsiteBackup({ EJE_BACKUP_OFFSITE_RCLONE: 'wasabi:eje-backups' });
    expect(remote[0]?.verdict).toBe('ok');
    expect(remote[0]?.detail).not.toContain('wasabi');
  });

  it('names the PDF text engine when poppler is there. LIB-TEXT-1', () => {
    const [check] = checkPdfTextEngine({});
    expect(check?.verdict).toBe('ok');
    expect(check?.detail).toMatch(/pdftotext/iu);
    expect(check?.detail).toMatch(/page by page/u);
  });

  it('WARNS when poppler is not installed, naming the package', () => {
    /*
     * NOT A FAILURE AND NOT SILENCE. Without poppler the application works and
     * the fallback is honest — but it reports EJE's own manuals as scans
     * needing recognition at 25 seconds a page, which is a far less useful
     * library than EJE expect. That is a thing to tell an operator.
     */
    const [check] = checkPdfTextEngine({ EJE_PDF_TEXT_BINARY: '/nonexistent/pdftotext' });
    expect(check?.verdict).toBe('warn');
    expect(check?.detail).toMatch(/poppler-utils/u);
    expect(check?.detail).toMatch(/name the page/u);
  });

  it('WARNS when the byte reader was asked for on purpose', () => {
    const [check] = checkPdfTextEngine({ EJE_PDF_TEXT: 'builtin' });
    expect(check?.verdict).toBe('warn');
    expect(check?.detail).toMatch(/unless that is deliberate/u);
  });

  it('FAILS a PDF-text engine value this build does not know', () => {
    // Same rule as EJE_OCR: an unset value and a misspelt one must say
    // different things, or a setting somebody believes is on turns a feature
    // off in silence.
    const [check] = checkPdfTextEngine({ EJE_PDF_TEXT: 'popler' });
    expect(check?.verdict).toBe('fail');
    expect(check?.detail).toMatch(/"popler"/u);
    expect(check?.detail).toMatch(/somebody believes a better one is/u);
  });

  it('says text recognition is OFF without calling that a problem', () => {
    // The state every EJE deployment is in, and whether to change it is EJE's
    // decision — so this must not read as a fault.
    const [check] = checkTextRecognition({});
    expect(check?.verdict).toBe('ok');
    expect(check?.detail).toMatch(/not searchable/u);
  });

  it('FAILS a text-recognition value this build does not know', () => {
    /*
     * `EJE_OCR=tesseract` is somebody who believes recognition is on. Every
     * document would settle as "no engine", honestly and invisibly — which is
     * the shape of problem a preflight is for.
     */
    const [check] = checkTextRecognition({ EJE_OCR: 'tesseract' });
    expect(check?.verdict).toBe('fail');
    expect(check?.detail).toMatch(/"tesseract"/u);
    expect(check?.detail).toMatch(/somebody believes it is/u);
  });

  it('WARNS on EJE_OCR=local, because the binaries are not checked here', () => {
    // The preflight reads configuration; whether tesseract is actually on the
    // machine is what `library:ocr --report` answers, and it says so.
    const [check] = checkTextRecognition({ EJE_OCR: 'local' });
    expect(check?.verdict).toBe('warn');
    expect(check?.detail).toMatch(/library:ocr/u);
  });

  it('WARNS when text recognition is on in PRODUCTION, which BD-21 did not ask for', () => {
    /*
     * BD-21 was answered as "the demonstration environment first, and measure
     * before deciding about production". A production deployment running it is
     * therefore recognition nobody approved, on the machine that also serves
     * the tablets — a warning rather than a failure, because the deployment
     * works and nothing leaves the premises.
     */
    const production = checkTextRecognition({ EJE_OCR: 'local', EJE_DEPLOYMENT: 'production' })[0];
    expect(production?.verdict).toBe('warn');
    expect(production?.detail).toMatch(/PRODUCTION/u);
    expect(production?.detail).toMatch(/BD-21/u);
    // The measured cost, because "it is slow" is not something to act on.
    expect(production?.detail).toMatch(/25 seconds/u);

    // And the demonstration posture is the one it was asked for.
    const demonstration = checkTextRecognition({ EJE_OCR: 'local' })[0];
    expect(demonstration?.verdict).toBe('warn');
    expect(demonstration?.detail).toMatch(/demonstration posture/u);
  });

  it('REPORTS export auditing as always on, with nothing to configure', () => {
    /*
     * BD-18 was answered on 23 October 2026: every export is recorded and the
     * records are kept indefinitely. This check used to report whether
     * `EJE_EXPORT_AUDIT` was set; there is no longer anything to set, and the
     * line now states the behaviour and the retention.
     */
    const check = checkExportAudit({})[0];
    expect(check?.verdict).toBe('ok');
    expect(check?.detail).toMatch(/always/iu);
    expect(check?.detail).toMatch(/indefinitely/u);
    // What is recorded and what is not, because "audited" without that is a
    // word somebody has to go and look up.
    expect(check?.detail).toMatch(/never the rows/iu);
  });

  it('SAYS SO when a stale EJE_EXPORT_AUDIT is still in the file', () => {
    /*
     * An operator who set the variable on an earlier release would otherwise
     * never learn that it is now dead — and might believe they could turn the
     * auditing back off with it.
     */
    const check = checkExportAudit({ EJE_EXPORT_AUDIT: 'on' })[0];
    expect(check?.verdict).toBe('ok');
    expect(check?.detail).toMatch(/NO LONGER READ/u);
  });
});
