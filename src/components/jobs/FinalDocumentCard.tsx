'use client';

import { useRouter } from 'next/navigation';
import { getJobTypeDefinition, userFullName, type Job, type User } from '@/domain';
import { Badge, Button, Card, CardHeader, DefinitionGrid, Icon } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

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
 * Demo note, stated on the card itself: no file is rendered server-side.
 * "Download" prints the same document component the production renderer will
 * consume, so the output is a real PDF with the stored filename rather than a
 * placeholder.
 */
export const FinalDocumentCard = ({
  job,
  users,
}: {
  readonly job: Job;
  readonly users: readonly User[];
}) => {
  const router = useRouter();
  const document = job.finalDocument;
  const label = getJobTypeDefinition(job.jobType).label;

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

      <div className="mt-4 flex flex-wrap gap-2 border-t border-verdant-200 pt-4">
        <Button
          leadingIcon={<Icon name="document" className="size-5" />}
          onClick={() => router.push(`/jobs/${job.jobNumber}/review`)}
        >
          View Final PDF
        </Button>
        <Button
          variant="secondary"
          leadingIcon={<Icon name="download" className="size-5" />}
          // Straight to the document with print open, so Download and View show
          // the same thing and the saved file carries the stored filename.
          onClick={() => router.push(`/jobs/${job.jobNumber}/review?print=1`)}
        >
          Download Final PDF
        </Button>
      </div>

      {document.simulated && (
        <p className="mt-3 text-xs text-amber-eje-700">
          Demonstration build: no file is rendered on a server. Download prints the document below
          to PDF through the browser, using the stored filename{' '}
          <span className="font-mono">{document.fileName}</span>. Production renders the same
          model server-side.
        </p>
      )}
    </Card>
  );
};
