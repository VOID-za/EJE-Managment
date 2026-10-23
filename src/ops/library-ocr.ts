import { loadEnvFiles } from '@/db/seed/env';
import { getDatabase } from '@/db/client';
import { createPostgresRepositories } from '@/data/postgres/repositories';
import { withTransaction } from '@/data/postgres/transaction';
import {
  describeSearchability,
  runOcrAttempt,
  summariseOcrQueue,
  type OcrAttempt,
  type OcrQueueSummary,
} from '@/application/library-ocr';
import { buildOcr, describeOcrLimits } from '@/services/ocr';
import { FilesystemStorageService, readStorageConfiguration } from '@/services/production/file-storage';
import { SystemClock, SequentialIdGenerator } from '@/services/simulated/system';
import { UuidGenerator } from '@/services/production/ids';
import type { OperationContext } from '@/application/context';
import type { AppServices } from '@/application/context';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { buildPdfText } from '@/services/pdf-text';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { asUserId, OCR_MAX_ATTEMPTS } from '@/domain';

/**
 * `npm run library:ocr` — READ THE SCANNED DOCUMENTS. MASTER SCOPE LIB-5.
 *
 * WHY A COMMAND AND NOT A REQUEST. Recognising a page takes 5 to 15 seconds, so
 * the 214-page manual `docs/library-ocr.md` costs is twenty minutes to an hour.
 * That cannot happen inside an upload: the request would time out, the
 * transaction would be held open for the whole of it, and the office would
 * watch a spinner. So an upload that finds no text layer records that the
 * document needs recognition and returns, and this is what comes along
 * afterwards and does the work.
 *
 *     npm run library:ocr                 take one job
 *     npm run library:ocr -- --max 20     take up to twenty
 *     npm run library:ocr -- --report     say what is waiting, do nothing
 *
 * RUN IT FROM CRON, or by hand after installing an engine. It takes one job at
 * a time and commits each one before taking the next, so a worker killed
 * halfway through a queue loses at most the job it was holding — and that one
 * is retried, because `claimOcrJob` treats a claim older than
 * `OCR_STALE_AFTER_MS` as abandoned.
 *
 * TWO WORKERS AT ONCE IS SAFE. `claimOcrJob` is a conditional UPDATE with
 * `FOR UPDATE SKIP LOCKED`, so the same job cannot go to both — which matters
 * because the alternative is two processes spending ten minutes each on the
 * same forty-page scan and then racing over whose text wins.
 *
 * IT SAYS WHAT IT DID AND WHAT IT COULD NOT. A deployment with no engine
 * installed prints the package names and exits ZERO: nothing is wrong with the
 * documents, nothing has been claimed for ever, and a cron job that mailed a
 * failure every night for a feature EJE have not switched on would be noise
 * somebody learns to filter.
 */

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
};

/**
 * The services this command needs, and honest stubs for the ones it does not.
 *
 * It reads a stored file and writes an index and an audit event. It sends
 * nothing — so the e-mail, WhatsApp and PDF services are the simulated ones,
 * which keep what they are given in memory and transmit nothing. A command
 * that could send a customer an e-mail as a side effect of reading a manual
 * would be a command nobody should run from cron.
 */
const buildServices = (): AppServices => {
  const clock = new SystemClock();
  const outbox = new SimulatedOutbox();
  const ids = new UuidGenerator();
  const messageIds = new SequentialIdGenerator();
  const storage = new FilesystemStorageService(readStorageConfiguration(process.env));
  return {
    clock,
    ids,
    storage,
    pdf: new SimulatedPdfService(clock),
    // The same engine the upload used, so a re-extraction during
    // recognition reads the document the same way. LIB-TEXT-1.
    pdfText: buildPdfText(),
    email: new SimulatedEmailService(outbox, clock, messageIds),
    whatsapp: new SimulatedWhatsAppService(outbox, clock, messageIds),
  };
};

const sayQueue = (summary: OcrQueueSummary): void => {
  process.stdout.write(
    `queue    ${summary.queued} waiting, ${summary.running} in flight, ${summary.done} done, ` +
      `${summary.failed} failed, ${summary.unavailable} with no engine\n`,
  );
};

const main = async (): Promise<void> => {
  loadEnvFiles();

  const url = (process.env.DATABASE_URL ?? '').trim();
  if (url.length === 0) {
    throw new Error(
      'DATABASE_URL is not set, so there is no library to read. See docs/vps-deployment.md.',
    );
  }

  const engine = buildOcr(process.env);
  const capability = engine.describe();
  const services = buildServices();
  const db = getDatabase();

  process.stdout.write('\n=== EJE LIBRARY TEXT RECOGNITION ===\n');
  process.stdout.write(
    capability.available
      ? `engine   ${capability.engine}\n`
      : `engine   NONE. ${capability.reason}\n`,
  );

  /*
   * THE LIMITS THIS RUN WILL ACTUALLY APPLY, printed from the environment.
   *
   * An operator wondering why a 214-page manual came back as forty pages
   * should be able to see the answer without reading the source — and an
   * operator who set `EJE_OCR_MAX_PAGES=lots` should be able to see that it
   * fell back to the default. Printed whether or not an engine is installed,
   * because that is when somebody is configuring it.
   */
  const limits = describeOcrLimits(process.env);
  process.stdout.write(
    `limits   ${limits.maxPages} page(s) per document · ` +
      `${limits.deadlineMinutes} minute deadline · ` +
      `${limits.maxInputMb} MB file · ${limits.maxTextMb} MB of text · language ${limits.language}\n`,
  );
  process.stdout.write(
    `         ${limits.rasteriser} + ${limits.recogniser}` +
      `${limits.overridden.length === 0 ? ' (all defaults)' : ` (set: ${limits.overridden.join(', ')})`}\n`,
  );

  /*
   * THE ACTOR IS THIS COMMAND, and it is named as such on the audit trail.
   * A background worker is not a person, and attributing its writes to
   * whichever Master happened to upload the file would put a decision in
   * somebody's name that they did not make.
   */
  const actor = {
    /*
     * A FIXED, RESERVED ID. The audit trail's `actor_id` has no foreign key to
     * `users` — it records who did a thing, including things no person did —
     * so this needs no row, and a nil-shaped UUID is recognisable as not a
     * person at a glance.
     */
    id: asUserId('00000000-0000-4000-8000-0000000000cr'.replace('cr', '11')),
    firstName: 'Text',
    lastName: 'recognition',
    initials: 'OCR',
    email: 'ocr@localhost',
    mobile: '',
    role: 'master' as const,
    jobTitle: 'Background worker',
    active: true,
    createdAt: services.clock.now(),
  };

  const contextFor = (repos: ReturnType<typeof createPostgresRepositories>): OperationContext => ({
    repos,
    services,
    actor,
  });

  /* -- report only --------------------------------------------------------- */
  if (flag('report')) {
    const repos = createPostgresRepositories(db);
    const jobs = await repos.documents.listOcrJobs();
    sayQueue(summariseOcrQueue(jobs));

    for (const job of jobs) {
      const document = await repos.documents.findById(job.documentId);
      const index = await repos.documents.findTextIndex(job.documentId);
      const said = describeSearchability(index, job);
      process.stdout.write(
        `         ${(document?.name ?? job.documentId).slice(0, 48).padEnd(50)} ${said.label}` +
          `${job.attempts === 0 ? '' : ` (${job.attempts}/${OCR_MAX_ATTEMPTS} attempts)`}\n`,
      );
    }
    process.stdout.write('\nNothing was read. Run without --report to do the work.\n');
    return;
  }

  /* -- do the work --------------------------------------------------------- */
  const limit = Math.max(1, Number(argument('max') ?? '1') || 1);
  let read = 0;
  let failed = 0;
  let unavailable = 0;

  for (let taken = 0; taken < limit; taken += 1) {
    /*
     * ONE TRANSACTION PER JOB, deliberately. A worker that died halfway
     * through twenty jobs must leave the nineteen it finished finished, and
     * one transaction around the batch would throw all of them away.
     */
    const outcome = await withTransaction(db, async (tx): Promise<OcrAttempt | null> => {
      const repos = createPostgresRepositories(tx);
      const claimed = await repos.documents.claimOcrJob(services.clock.now());
      if (claimed === null) return null;
      return runOcrAttempt(contextFor(repos), engine, claimed);
    });

    if (outcome === null) break;

    const document = await createPostgresRepositories(db).documents.findById(
      outcome.job.documentId,
    );
    const name = document?.name ?? outcome.job.documentId;

    if (outcome.job.state === 'done') {
      read += 1;
      process.stdout.write(
        `read     ${name}: ${outcome.index?.characters ?? 0} characters from ` +
          `${outcome.index?.pages ?? 0} page(s)` +
          `${outcome.index?.truncated === true ? ', and the document is longer than that' : ''}\n`,
      );
    } else if (outcome.job.state === 'unavailable') {
      unavailable += 1;
      process.stdout.write(`skipped  ${name}: ${outcome.job.lastError}\n`);
      /*
       * NO POINT TAKING ANOTHER. Every job will answer the same way, and
       * twenty identical lines about a missing package is not more useful than
       * one. The jobs are left `unavailable`, which `requeueOcr` undoes once
       * somebody installs an engine.
       */
      break;
    } else {
      failed += 1;
      process.stdout.write(`FAILED   ${name}: ${outcome.job.lastError}\n`);
    }
  }

  const repos = createPostgresRepositories(db);
  sayQueue(summariseOcrQueue(await repos.documents.listOcrJobs()));

  if (read === 0 && failed === 0 && unavailable === 0) {
    process.stdout.write('Nothing was waiting.\n');
    return;
  }

  process.stdout.write(
    `\n${read} document(s) read, ${failed} failed, ${unavailable} skipped for want of an engine.\n`,
  );
  /*
   * ZERO EVEN WHEN NOTHING COULD BE READ. A missing engine is a configuration
   * EJE have not made rather than a fault, and a cron job that mailed a
   * failure every night for a feature nobody has switched on is noise somebody
   * learns to filter — and then misses the night it means something. A document
   * that could not be read is on the queue, in the report and on the audit
   * trail, which is where it belongs.
   */
};

/**
 * THE POOL IS CLOSED, or the command never exits.
 *
 * `getDatabase()` returns the process-wide client, which keeps a socket open
 * and therefore keeps the event loop alive — fine in a server, fatal in a
 * command meant to be run from cron. The first version of this ran correctly,
 * printed its report, and then sat there for ever.
 */
const closeDatabase = async (): Promise<void> => {
  try {
    await getDatabase().$client.end({ timeout: 5 });
  } catch {
    // Already closed, or never opened. Either way there is nothing to do and
    // nothing worth saying after the work has been reported.
  }
};

void main()
  .then(closeDatabase)
  .catch(async (cause: unknown) => {
  await closeDatabase();
    const message = cause instanceof Error ? cause.message : String(cause);
    const url = (process.env.DATABASE_URL ?? '').trim();
    process.stderr.write(
      `library  FAILED: ${url.length === 0 ? message : message.split(url).join('[connection string]')}\n`,
    );
  process.exitCode = 1;
});
