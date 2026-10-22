import { classifyDatabaseUrl } from '@/db/connection-guard';
import { DEPLOYMENT, deploymentMismatch, deploymentModeOf } from './deployment-mode';
import { chooseEmailTransport, describeEmailConfiguration } from '@/services/production/email';
import { readSmtpEmailConfiguration } from '@/services/development/email';

/**
 * IS THIS MACHINE CONFIGURED TO SERVE EJE? MASTER SCOPE ARCH-5, MANDATE-3.
 *
 * The repository has had a systemd unit, a Caddyfile, an environment template
 * and a twenty-step runbook since the deployment phase. What it has never had
 * is the thing an operator runs BEFORE `systemctl start`: one command that
 * reads the machine's own configuration and says, line by line, whether this
 * deployment would work — and refuses rather than starting a server that looks
 * healthy and is quietly wrong.
 *
 * THE FAILURES THIS EXISTS FOR ARE ALL SILENT ONES.
 *
 *   - `DATABASE_URL` missing or misspelt: `src/data/backend.ts` falls back to
 *     the in-memory DEMONSTRATION store, so the deployment serves a fictional
 *     company to real users and discards every write on restart. `/api/health`
 *     says `"backend":"demo"` — after the fact, to whoever thinks to look.
 *   - The staging service pointed at the production database. Nothing in a
 *     connection string says which deployment it belongs to, so this takes the
 *     expected database NAME as an argument and refuses a mismatch.
 *   - A migration not applied. The application starts, and the first request
 *     touching the new column fails.
 *   - `EJE_STORAGE_DIR` unset or unwritable: every issued job card is a file
 *     that cannot be written, discovered at the moment a customer should have
 *     received one. Worse, a storage directory INSIDE the application
 *     directory is deleted by the next deployment.
 *   - No email configuration: a real-database deployment refuses to send
 *     (MANDATE-3), which is correct and means no customer gets their job card.
 *   - `EJE_DEMO_SWITCHER` left on: one-click sign-in as accounts whose
 *     password is published in the documentation.
 *
 * NOTHING HERE PRINTS A VALUE. Not a password, not a token, not a host, not
 * even the length of a secret. A verdict names the VARIABLE and says what is
 * wrong with it, because that is what an operator needs and the output of this
 * command will end up in a terminal somebody is sharing.
 *
 * The rules are pure and live apart from the command (`preflight.ts`) so they
 * can be tested without a database, a disk or a deployment.
 */

export type Verdict = 'ok' | 'warn' | 'fail';

export interface Check {
  /** What was checked, in the operator's terms. */
  readonly name: string;
  readonly verdict: Verdict;
  /** What is true, and what to do about it. NEVER a configured value. */
  readonly detail: string;
}

export const ok = (name: string, detail: string): Check => ({ name, verdict: 'ok', detail });
export const warn = (name: string, detail: string): Check => ({ name, verdict: 'warn', detail });
export const fail = (name: string, detail: string): Check => ({ name, verdict: 'fail', detail });

/** A preflight passes when nothing FAILED. Warnings are for a person to read. */
export const passed = (checks: readonly Check[]): boolean =>
  checks.every((check) => check.verdict !== 'fail');

export interface PreflightEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly DATABASE_URL?: string | undefined;
  readonly EJE_PERSISTENCE?: string | undefined;
  readonly EJE_STORAGE_DIR?: string | undefined;
  readonly EJE_BACKUP_KEY?: string | undefined;
  readonly EJE_BACKUP_DIR?: string | undefined;
  readonly EJE_DEMO_SWITCHER?: string | undefined;
  readonly EJE_DEPLOYMENT?: string | undefined;
  readonly EJE_BUILD_COMMIT?: string | undefined;
  readonly WHATSAPP_PHONE_NUMBER_ID?: string | undefined;
  readonly WHATSAPP_ACCESS_TOKEN?: string | undefined;
  readonly [key: string]: string | undefined;
}

const value = (env: PreflightEnvironment, name: string): string => (env[name] ?? '').trim();

/**
 * WHICH BACKEND THIS DEPLOYMENT WOULD ACTUALLY USE.
 *
 * The silent fallback is the whole reason for this check: an absent
 * `DATABASE_URL` is not an error at startup, it is the demonstration store.
 */
export const checkBackend = (env: PreflightEnvironment): readonly Check[] => {
  const checks: Check[] = [];
  const persistence = value(env, 'EJE_PERSISTENCE').toLowerCase();
  const url = value(env, 'DATABASE_URL');

  if (url.length === 0) {
    checks.push(
      fail(
        'DATABASE_URL',
        'Not set. The application would fall back to the in-memory DEMONSTRATION store: ' +
          'fictional customers, and every write lost on restart.',
      ),
    );
  }

  if (persistence === 'postgres') {
    checks.push(ok('EJE_PERSISTENCE', 'postgres — the backend is named rather than inferred.'));
  } else if (persistence.length === 0) {
    checks.push(
      warn(
        'EJE_PERSISTENCE',
        'Not set. The backend is then inferred from DATABASE_URL, so a typo in that line ' +
          'becomes the demonstration store instead of a refusal. Set it to postgres.',
      ),
    );
  } else if (persistence === 'demo') {
    checks.push(
      fail(
        'EJE_PERSISTENCE',
        'demo — this deployment would serve the in-memory demonstration store. Correct for a ' +
          'sales laptop, wrong for anything with users.',
      ),
    );
  } else {
    checks.push(fail('EJE_PERSISTENCE', `"${persistence}" is not a backend this application has.`));
  }

  return checks;
};

/**
 * THE DATABASE THIS SERVICE WOULD WRITE TO, BY NAME, AND WHETHER IT IS THE ONE
 * THE OPERATOR MEANT.
 *
 * `expectDatabase` is the staging guard. Nothing in a connection string says
 * which deployment it belongs to, so a staging unit started with production's
 * environment file is indistinguishable from a correct one — until it writes.
 * The NAME is reported because an operator needs it and it is not a secret; the
 * user, the password and the host are not.
 */
export const checkDatabaseTarget = (
  env: PreflightEnvironment,
  expectDatabase: string | null,
): readonly Check[] => {
  const url = value(env, 'DATABASE_URL');
  if (url.length === 0) return [];

  const target = classifyDatabaseUrl(url);
  if (target.databaseName.length === 0) {
    return [
      fail(
        'DATABASE_URL',
        'Set, and not a URL naming a database. Nothing is said about its contents.',
      ),
    ];
  }

  /*
   * The KIND the application's own connection guard assigns, reused rather
   * than restated — two lists meant to agree and written twice are two lists
   * that will one day disagree, and the wrong one will be the one in front of
   * the live database.
   */
  const checks: Check[] = [
    ok('Database', `"${target.databaseName}" (${target.kind} by the connection guard's reckoning).`),
  ];

  if (expectDatabase !== null && expectDatabase !== target.databaseName) {
    checks.push(
      fail(
        'Database target',
        `This deployment expects "${expectDatabase}" and is configured for ` +
          `"${target.databaseName}". Refused: starting would write to the wrong database.`,
      ),
    );
  }

  if (target.kind !== 'local' && target.kind !== 'production') {
    checks.push(
      warn(
        'Database host',
        'Not a local host. The deployment documentation puts PostgreSQL on the same machine, so ' +
          'a database reached across a network here is worth a second look.',
      ),
    );
  }

  return checks;
};

/**
 * MIGRATIONS APPLIED, by comparing what the repository ships with what the
 * database has actually run. Names only — a migration tag is not a secret.
 *
 * THREE DIFFERENT ANSWERS, AND THE MIDDLE ONE IS WHY THIS IS NOT A SUBTRACTION.
 * Drizzle's ledger can be EMPTY on a database whose schema is complete: a
 * restore from a dump carries the tables and not the ledger, and so does a
 * database built by the test harness. Reporting "thirteen migrations not
 * applied" there is alarming and wrong — the schema is present and nothing is
 * pending — so an empty ledger beside a real schema is reported as what it is.
 * The first draft of this check made exactly that mistake against the test
 * database, which is how the distinction came to be written down.
 */
export interface MigrationFacts {
  /** Rows in drizzle's ledger, or null when it could not be read at all. */
  readonly applied: number | null;
  /** Whether the application's own tables are there. */
  readonly schemaPresent: boolean;
}

export const checkMigrations = (
  shipped: readonly string[],
  facts: MigrationFacts,
): readonly Check[] => {
  if (shipped.length === 0) {
    return [fail('Migrations', 'The repository ships none, which cannot be right.')];
  }
  if (facts.applied === null) {
    return [
      fail(
        'Migrations',
        "Drizzle's migration ledger could not be read, so it is impossible to say whether this " +
          'database is up to date. Either the migrations have never run here or this is not an ' +
          'EJE database.',
      ),
    ];
  }
  if (facts.applied === 0 && facts.schemaPresent) {
    return [
      warn(
        'Migrations',
        `The schema is present and the ledger is empty, so this database was built by something ` +
          `other than \`npm run db:migrate\` — a restored dump, or a test harness. Nothing is ` +
          `pending, and the next migration will try to apply all ${shipped.length} from the ` +
          `beginning. Reconcile the ledger before the next schema change.`,
      ),
    ];
  }
  const pending = shipped.slice(facts.applied);
  if (pending.length === 0) {
    return [ok('Migrations', `all ${shipped.length} applied.`)];
  }
  return [
    fail(
      'Migrations',
      `${pending.length} not applied: ${pending.join(', ')}. Run the migration before starting ` +
        'the service — the application will otherwise fail at the first request touching the ' +
        'new schema.',
    ),
  ];
};

/**
 * WHERE THE DOCUMENTS GO. Three different failures, and the third is the one
 * nobody expects: a storage directory inside the application directory is
 * deleted by the next deployment, taking every signed job card with it.
 */
export interface StorageFacts {
  readonly configured: string;
  readonly exists: boolean;
  readonly writable: boolean;
  /** True when the directory sits inside the deployed application directory. */
  readonly insideApplication: boolean;
}

export const checkStorage = (facts: StorageFacts): readonly Check[] => {
  if (facts.configured.length === 0) {
    return [
      fail(
        'EJE_STORAGE_DIR',
        'Not set. Issued job cards and attachments have nowhere to live, and the default is ' +
          'not a place anybody backs up.',
      ),
    ];
  }
  const checks: Check[] = [];
  if (!facts.exists) {
    checks.push(
      fail('EJE_STORAGE_DIR', 'Set, and the directory does not exist. Create it and give the service user write access.'),
    );
  } else if (!facts.writable) {
    checks.push(
      fail(
        'EJE_STORAGE_DIR',
        'The directory exists and this user cannot write to it. Every issued document would ' +
          'fail at the moment a customer should have received one.',
      ),
    );
  } else {
    checks.push(ok('EJE_STORAGE_DIR', 'Exists and is writable by this user.'));
  }

  if (facts.insideApplication) {
    checks.push(
      fail(
        'EJE_STORAGE_DIR',
        'It is inside the application directory. The next deployment replaces that directory, ' +
          'which would delete every stored job card. Move it to its own volume.',
      ),
    );
  }
  return checks;
};

/** The backup key, by SHAPE. Never printed, never measured out loud. */
export const checkBackupKey = (env: PreflightEnvironment): readonly Check[] => {
  const key = value(env, 'EJE_BACKUP_KEY');
  if (key.length === 0) {
    return [
      warn(
        'EJE_BACKUP_KEY',
        'Not set. `npm run backup` refuses without it, so this machine cannot take a backup ' +
          'at all. Nothing else is affected.',
      ),
    ];
  }
  if (!/^[0-9a-fA-F]{64}$/u.test(key)) {
    return [
      fail(
        'EJE_BACKUP_KEY',
        'Set and not 32 bytes of hexadecimal, so every backup would be refused. Generate one ' +
          'with `openssl rand -hex 32`.',
      ),
    ];
  }
  return [ok('EJE_BACKUP_KEY', 'Present and the right shape. Its value is not read here.')];
};

/**
 * WHERE A BACKUP ALSO LIVES. BACKUP-2.
 *
 * A backup that exists only on the machine it is a backup OF does not survive
 * that machine, which is the one failure a backup exists to cover. `npm run
 * backup` already says so after every run — this says it BEFORE the service
 * starts, where somebody is in a position to configure it.
 *
 * A WARNING AND NOT A FAILURE, deliberately: a deployment can legitimately run
 * for a day without an off-site destination while somebody arranges one, and a
 * check that refuses to start the service over it would be a check people
 * learn to bypass.
 */
export const checkOffsiteBackup = (env: PreflightEnvironment): readonly Check[] => {
  const directory = value(env, 'EJE_BACKUP_OFFSITE_DIR');
  const remote = value(env, 'EJE_BACKUP_OFFSITE_RCLONE');
  if (directory.length === 0 && remote.length === 0) {
    return [
      warn(
        'Off-site backup',
        'No off-site destination. Every backup would exist only on this machine, so it does ' +
          'not survive this machine — set EJE_BACKUP_OFFSITE_DIR to a mounted volume or ' +
          'EJE_BACKUP_OFFSITE_RCLONE to an rclone remote. See docs/vps-backups.md.',
      ),
    ];
  }
  return [
    ok(
      'Off-site backup',
      directory.length > 0
        ? 'A mounted volume is configured. Its path is not read here.'
        : 'An rclone remote is configured. Its name is not read here.',
    ),
  ];
};

/**
 * A FEATURE SOMEBODY BELIEVES IS ON. LIB-5.
 *
 * `EJE_OCR=local` is a deployment saying it has installed `tesseract` and
 * `pdftoppm` and wants them used. If they are NOT there, every queued document
 * settles as `unavailable` — which is honest, and invisible to whoever set the
 * variable and thinks text recognition is working. This is where that gets
 * noticed.
 *
 * UNSET IS FINE AND SAYS SO: no engine is the state every EJE deployment is in
 * today, and whether to install one is EJE's decision (`docs/library-ocr.md`).
 */
export const checkTextRecognition = (env: PreflightEnvironment): readonly Check[] => {
  const configured = value(env, 'EJE_OCR').toLowerCase();
  if (configured.length === 0) {
    return [
      ok(
        'Text recognition',
        'Not configured. A scanned document is recorded as not searchable and says so, which ' +
          'is the state every deployment is in until EJE decide otherwise.',
      ),
    ];
  }
  if (configured !== 'local') {
    return [
      fail(
        'Text recognition',
        `EJE_OCR is "${configured}", which is not an engine this build knows — the only value ` +
          'is `local`. Nothing is being recognised, and somebody believes it is.',
      ),
    ];
  }
  return [
    warn(
      'Text recognition',
      'EJE_OCR=local. Run `npm run library:ocr -- --report` to confirm the binaries are ' +
        'actually installed — if they are not, every document settles as "no engine" and ' +
        'nothing says so on a screen.',
    ),
  ];
};

/**
 * MONITORING OF EJE'S OWN STAFF, IF IT IS ON. BD-18.
 *
 * `EJE_EXPORT_AUDIT=on` records who exported which list, when and with which
 * filters. That is a defensible thing for EJE to want and a surprising thing
 * for a deployment to do without anybody saying so — so it is REPORTED either
 * way, which is the only reason this check exists. Neither state is a problem.
 */
export const checkExportAudit = (env: PreflightEnvironment): readonly Check[] => {
  const on = value(env, 'EJE_EXPORT_AUDIT').toLowerCase() === 'on';
  return [
    ok(
      'Export auditing',
      on
        ? 'ON. Every spreadsheet export is recorded on the audit trail with who took it and ' +
            'which filters — monitoring of staff, and retention is unmanaged (BD-18).'
        : 'Off. Spreadsheet exports are not recorded on the audit trail (BD-18, open).',
    ),
  ];
};

/**
 * WHETHER A CUSTOMER COULD ACTUALLY BE SENT THEIR JOB CARD. MANDATE-3.
 *
 * A real-database deployment with no email configuration refuses to send, which
 * is the correct behaviour and means nothing reaches a customer. That is a
 * deployment blocker, not a warning — so it fails here, where somebody can fix
 * it, rather than on the first signed job card.
 */
export const checkEmail = (env: PreflightEnvironment, isDemoBackend: boolean): readonly Check[] => {
  const report = describeEmailConfiguration(env);
  const transport = chooseEmailTransport({
    graphConfigured: report.configured,
    smtpConfigured: readSmtpEmailConfiguration(env) !== null,
    isProduction: value(env, 'NODE_ENV') === 'production',
    isDemoBackend,
  });
  /*
   * A DEMONSTRATION DEPLOYMENT WITH NO MAIL IS CORRECT, NOT BROKEN.
   *
   * The same mistake the switcher check used to make, in the other direction:
   * "no customer receives a job card" is a deployment blocker where there are
   * customers and the intended state where there are not. Judged on the
   * DECLARED deployment rather than on which store is behind it, because the
   * demonstration site runs PostgreSQL — `isDemoBackend` is false there and
   * says nothing about whether anybody real is waiting for mail.
   *
   * An UNDECLARED deployment keeps the stricter reading. The mandate's words:
   * distinguish "a safe deployment with integrations intentionally disabled"
   * from "a release that claims customer communications are ready".
   */
  const demonstration = deploymentModeOf(env) === 'demonstration';

  const checks: Check[] = [];
  switch (transport) {
    case 'graph':
      checks.push(ok('Customer email', 'Microsoft 365 (Graph) is configured for this deployment.'));
      break;
    case 'smtp':
      checks.push(
        warn(
          'Customer email',
          'SMTP, which is a development transport and is never selected in production. No ' +
            'delivery reports, so a job closes only on the outbox screen.',
        ),
      );
      break;
    case 'simulated':
      checks.push(
        warn(
          'Customer email',
          'The demonstration outbox. Nothing is transmitted — correct for a demonstration ' +
            'deployment and wrong for anything with customers.',
        ),
      );
      break;
    case 'refuse':
      checks.push(
        demonstration
          ? warn(
              'Customer email',
              'Not configured, so this deployment REFUSES to send and nothing reaches a ' +
                'mailbox. That is CORRECT for a demonstration deployment and is not a blocker ' +
                `here. Missing: ${report.missing.join(', ')}. It IS a blocker on a deployment ` +
                'declared production.',
            )
          : fail(
              'Customer email',
              'Not configured, so this deployment REFUSES to send and no customer receives a job ' +
                `card. Missing: ${report.missing.join(', ')}.`,
            ),
      );
      break;
  }

  for (const problem of report.problems) {
    checks.push(warn('Customer email', problem));
  }
  return checks;
};

/** WhatsApp is optional: configured, or refusing and saying so. */
export const checkWhatsApp = (env: PreflightEnvironment): readonly Check[] => {
  const id = value(env, 'WHATSAPP_PHONE_NUMBER_ID');
  const token = value(env, 'WHATSAPP_ACCESS_TOKEN');
  if (id.length > 0 && token.length > 0) {
    return [ok('WhatsApp', 'Configured. The site-location message can be sent.')];
  }
  if (id.length === 0 && token.length === 0) {
    return [
      warn(
        'WhatsApp',
        'Not configured. The application refuses to send a site location rather than pretending, ' +
          'which is the documented behaviour.',
      ),
    ];
  }
  return [
    fail(
      'WhatsApp',
      'Half configured. Both WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are needed, and ' +
        'one of them is missing.',
    ),
  ];
};

/**
 * WHICH DEPLOYMENT THIS IS, AND WHETHER ITS DATABASE AGREES.
 * October mandate, Workstream A.
 *
 * THE CHECK THIS REPLACED COULD NOT PASS. An armed demonstration switcher was
 * an unconditional FAIL — correct for production, and wrong for
 * `eje.syncza.co.za`, whose whole purpose is people signing in as the seeded
 * accounts. A preflight that has to be overridden to deploy the deployment it
 * was written for is a preflight nobody reads.
 *
 * So the deployment says which it is (`EJE_DEPLOYMENT`), and this reports the
 * three things that can then be wrong: an undeclared deployment, a declared
 * one whose database contradicts it, and a demonstration feature armed on
 * production. See `src/ops/deployment-mode.ts` for why a declaration is the
 * third line of defence rather than the first.
 */
export const checkDeployment = (env: PreflightEnvironment): readonly Check[] => {
  const mode = deploymentModeOf(env);
  const declared = value(env, DEPLOYMENT);
  const checks: Check[] = [];

  if (mode === 'undeclared') {
    checks.push(
      declared.length === 0
        ? warn(
            DEPLOYMENT,
            'Not set, so this deployment has not said whether it is production or a ' +
              'demonstration. Every guard behaves as it did before the line existed, which is ' +
              'safe and leaves the demonstration switcher judged by its own configuration ' +
              'alone. Set it to production or demonstration.',
          )
        : fail(
            DEPLOYMENT,
            'Set to something this application does not recognise, so it has been IGNORED ' +
              'rather than guessed at. The two values are production and demonstration.',
          ),
    );
  } else {
    checks.push(
      ok(DEPLOYMENT, `${mode} — declared rather than inferred from the build or the database name.`),
    );
  }

  const mismatch = deploymentMismatch(env);
  if (mismatch !== null) {
    checks.push(fail('Deployment target', mismatch.reason));
  }

  return checks;
};

/**
 * THE DEMONSTRATION SIGN-IN SWITCH, which is the one setting that can turn a
 * real deployment into a public one.
 *
 * It is armed only when its value NAMES the configured database, which is the
 * mechanism rather than a word meaning yes — so this compares the two and says
 * so plainly when they match.
 *
 * WHAT THE DECLARED MODE CHANGES HERE. On a `production` deployment the
 * switcher is refused by the RUNTIME whatever this file says
 * (`isDemoSwitcherEnabled`), so an armed line there is reported as the
 * configuration error it is rather than as a live exposure. On a
 * `demonstration` deployment an armed switcher is the intended state and
 * passes. Undeclared keeps the original, stricter reading: a deployment that
 * has not said what it is gets the benefit of no doubt.
 */
export const checkDemoSwitcher = (env: PreflightEnvironment): readonly Check[] => {
  const mode = deploymentModeOf(env);
  const switcher = value(env, 'EJE_DEMO_SWITCHER');

  if (switcher.length === 0) {
    if (mode === 'demonstration') {
      return [
        warn(
          'EJE_DEMO_SWITCHER',
          'Not set on a deployment that declares itself a demonstration, so nobody can sign in ' +
            'as the seeded accounts. Set it to the name of this database if that is the point ' +
            'of this deployment.',
        ),
      ];
    }
    return [ok('EJE_DEMO_SWITCHER', 'Not set.')];
  }

  const url = value(env, 'DATABASE_URL');
  const databaseName = url.length === 0 ? '' : classifyDatabaseUrl(url).databaseName;
  const armed = switcher === databaseName;

  if (mode === 'production') {
    return [
      fail(
        'EJE_DEMO_SWITCHER',
        'Set on a deployment that declares itself PRODUCTION. The runtime refuses to arm it ' +
          `there — nobody can use it — but the line should not be in a production environment ` +
          'file at all, because the next deployment to inherit this file may not declare itself.',
      ),
    ];
  }

  if (!armed) {
    return [
      warn(
        'EJE_DEMO_SWITCHER',
        'Set, and it does not name the configured database, so it is inert. Remove it to avoid ' +
          'arming it by accident the next time the database changes.',
      ),
    ];
  }

  if (mode === 'demonstration') {
    return [
      ok(
        'EJE_DEMO_SWITCHER',
        `Armed for "${databaseName}" on a deployment that declares itself a demonstration. ` +
          'That is the intended configuration: one-click sign-in as the seeded accounts, whose ' +
          'password is published. It must not be carried to a deployment holding real ' +
          'customers — see docs/demonstration-data.md.',
      ),
    ];
  }

  return [
    fail(
      'EJE_DEMO_SWITCHER',
      `ARMED for "${databaseName}": anybody reaching this deployment can sign in as the ` +
        'seeded accounts whose password is published in the documentation. Remove the line, or ' +
        `declare this deployment with ${DEPLOYMENT}=demonstration if that is what it is.`,
    ),
  ];
};

/** What the process itself is, and whether the build it would serve is there. */
export const checkRuntime = (
  env: PreflightEnvironment,
  facts: { readonly buildPresent: boolean; readonly buildCommit: string },
): readonly Check[] => {
  const checks: Check[] = [];
  if (value(env, 'NODE_ENV') === 'production') {
    checks.push(ok('NODE_ENV', 'production.'));
  } else {
    checks.push(
      warn(
        'NODE_ENV',
        'Not production. `next start` serves the built output either way, but development ' +
          'transports become selectable and error output is more generous.',
      ),
    );
  }

  if (!facts.buildPresent) {
    checks.push(
      fail('Build', 'There is no built output here. Run the production build before starting.'),
    );
  } else {
    checks.push(
      ok(
        'Build',
        facts.buildCommit.length === 0
          ? 'Built output present. EJE_BUILD_COMMIT is not set, so /api/health cannot say which commit it serves.'
          : `Built output present, stamped ${facts.buildCommit}.`,
      ),
    );
  }
  return checks;
};
