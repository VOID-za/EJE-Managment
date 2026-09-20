'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { getJobTypeDefinition, userFullName, type Job, type User } from '@/domain';
import { Badge, Button, Card, CardHeader, DefinitionGrid, Icon } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { downloadBytes } from '@/lib/download';
import { formatDateTime } from '@/lib/format';
import { jobs } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';

/**
 * The official final job card on a closed job.
 *
 * The document is not regenerated here. It was produced once, when the Master
 * finalised the job, and `job.finalDocument` records exactly which document
 * that was. Combined with the frozen pricing snapshot and the checklist
 * resolved by its stored version, reopening this years later produces the same
 * job card — a later rate change, part price or checklist revision cannot reach
 * it.
 *
 * View and Download are deliberately DIFFERENT actions:
 *
 * - View opens the document on screen, in the review page's viewer.
 * - Download retrieves the stored file and writes it to the device. It does not
 *   print, does not open a print dialog and does not render a new document: it
 *   reads back the bytes written when the Master issued the job card.
 */
export const FinalDocumentCard = ({
  job,
  users,
}: {
  readonly job: Job;
  readonly users: readonly User[];
}) => {
  const router = useRouter();
  const operation = useOperation();
  const [downloaded, setDownloaded] = useState(false);
  const document = job.finalDocument;
  const label = getJobTypeDefinition(job.jobType).label;

  /**
   * Download: storage -> device. No print dialog, no re-render.
   *
   * Resolved by job number through the application layer, so the only file this
   * can ever fetch is the one recorded on this job.
   */
  const download = useCallback(async () => {
    setDownloaded(false);
    const ok = await operation.run(async () => {
      const file = await jobs.finalDocument(job.jobNumber);
      downloadBytes(file.bytes, file.fileName, file.contentType);
    });
    if (ok) setDownloaded(true);
  }, [operation, job.jobNumber]);

  const issuedBy =
    document === null
      ? null
      : (users.find((user) => user.id === document.generatedBy) ?? null);

  if (document === null) {
    return (
      <Card className="mb-5 border-steel-300">
        <CardHeader
          title="No final document on file"
          description={`This ${label.toLowerCase()} job was closed before final documents were stored against the job. Its historical record below is complete and unchanged.`}
        />
        <Button
          className="mt-4"
          variant="secondary"
          leadingIcon={<Icon name="document" className="size-4" />}
          onClick={() => router.push(`/jobs/${job.jobNumber}/review`)}
        >
          View job card
        </Button>
      </Card>
    );
  }

  return (
    <Card className="mb-5 border-verdant-300 bg-verdant-50/40">
      <CardHeader
        title="Final signed job card"
        description="The official document issued to the customer. Held as issued — later rate, price or checklist changes cannot alter it."
        action={
          <Badge tone="green" size="sm" dot>
            On file
          </Badge>
        }
      />

      <DefinitionGrid
        className="mt-4"
        columns={3}
        items={[
          { label: 'File', value: <span className="font-mono text-xs">{document.fileName}</span> },
          { label: 'Pages', value: `${document.pageCount}` },
          { label: 'Issued', value: formatDateTime(document.generatedAt) },
          {
            label: 'Issued by',
            value: issuedBy === null ? 'the office' : userFullName(issuedBy),
          },
          { label: 'Emailed to', value: document.issuedTo, wide: true },
        ]}
      />

      {operation.error !== null && (
        <div className="mt-4">
          <RuleViolationNotice
            title="The final job card could not be opened"
            message={operation.error}
            violations={operation.violations}
          />
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-verdant-200 pt-4">
        {/* View: show it on screen. */}
        <Button
          leadingIcon={<Icon name="document" className="size-5" />}
          onClick={() => router.push(`/jobs/${job.jobNumber}/review`)}
        >
          View Final PDF
        </Button>
        {/* Download: write the stored file to the device. Never prints. */}
        <Button
          variant="secondary"
          leadingIcon={<Icon name="download" className="size-5" />}
          onClick={download}
          loading={operation.running}
        >
          Download Final PDF
        </Button>
        {downloaded && (
          <span className="text-xs font-medium text-verdant-700">
            <Icon name="check" className="mr-1 inline size-3.5" />
            {document.fileName} downloaded
          </span>
        )}
      </div>

      {document.simulated && (
        <p className="mt-3 text-xs text-amber-eje-700">
          Demonstration build: the PDF is rendered by this application rather than by a server, and
          was written to storage once, when the job card was issued. Download returns that stored
          file as <span className="font-mono">{document.fileName}</span> — it does not build a new
          one. In production the same document is rendered server-side and served from object
          storage.
        </p>
      )}
    </Card>
  );
};
