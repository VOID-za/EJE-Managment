'use client';

import { useEffect, useState } from 'react';
import type { Job, JobCompletionReport } from '@/domain';
import { saveCompletionReport } from '@/application/job-operations';
import { Badge, Button, Card, CardHeader, TextAreaField } from '@/components/ui';
import { useOperation } from '@/hooks/useOperation';

const FIELDS: readonly {
  key: keyof JobCompletionReport;
  label: string;
  placeholder: string;
  hint: string;
  required: boolean;
}[] = [
  {
    key: 'faultFindings',
    label: 'Fault findings',
    placeholder: 'What did you find when you arrived and investigated?',
    hint: 'The condition found on site.',
    required: false,
  },
  {
    key: 'diagnosis',
    label: 'Diagnosis',
    placeholder: 'What was the root cause?',
    hint: 'Why the fault occurred.',
    required: false,
  },
  {
    key: 'workPerformed',
    label: 'Work performed',
    placeholder: 'What did you actually do to the machine?',
    hint: 'This is the core of the customer job card and is required before signature.',
    required: true,
  },
  {
    key: 'recommendations',
    label: 'Recommendations',
    placeholder: 'What should the customer do next?',
    hint: 'Follow-up work, parts to budget for, or preventative advice.',
    required: false,
  },
  {
    key: 'generalNotes',
    label: 'General notes',
    placeholder: 'Anything else worth recording.',
    hint: '',
    required: false,
  },
];

/**
 * Completion write-up.
 *
 * Saves are explicit rather than on every keystroke, and the panel warns before
 * the technician navigates away with unsaved text — user data is never silently
 * discarded.
 */
export const CompletionReportPanel = ({
  job,
  editable,
  onChanged,
}: {
  readonly job: Job;
  readonly editable: boolean;
  readonly onChanged: () => void;
}) => {
  const operation = useOperation();
  const [draft, setDraft] = useState<JobCompletionReport>(job.completionReport);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const dirty = FIELDS.some((field) => draft[field.key] !== job.completionReport[field.key]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async () => {
    const ok = await operation.run((context) => saveCompletionReport(context, job, draft));
    if (ok) {
      setSavedAt(new Date().toISOString());
      onChanged();
    }
  };

  return (
    <Card>
      <CardHeader
        title="Completion write-up"
        description="This text is printed on the customer job card. Write it for the customer, not for the office."
        action={
          dirty ? (
            <Badge tone="amber" size="sm" dot>
              Unsaved changes
            </Badge>
          ) : savedAt !== null ? (
            <Badge tone="green" size="sm">
              Saved
            </Badge>
          ) : undefined
        }
      />

      <div className="mt-5 space-y-4">
        {FIELDS.map((field) => (
          <TextAreaField
            key={field.key}
            label={field.label}
            required={field.required}
            hint={field.hint}
            rows={field.key === 'workPerformed' ? 5 : 3}
            disabled={!editable}
            value={draft[field.key]}
            onChange={(event) =>
              setDraft((current) => ({ ...current, [field.key]: event.target.value }))
            }
            placeholder={field.placeholder}
          />
        ))}
      </div>

      {operation.error !== null && (
        <p role="alert" className="mt-3 text-sm text-signal-600">
          {operation.error}
        </p>
      )}

      {editable && (
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-steel-100 pt-4">
          <Button
            variant="secondary"
            onClick={() => setDraft(job.completionReport)}
            disabled={!dirty || operation.running}
          >
            Discard changes
          </Button>
          <Button onClick={save} loading={operation.running} disabled={!dirty}>
            Save write-up
          </Button>
        </div>
      )}
    </Card>
  );
};
