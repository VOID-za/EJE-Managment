'use client';

import { useState } from 'react';
import { can, type TechnicalDocumentType } from '@/domain';
import { addDocument } from '@/application/library-operations';
import { Button, Modal, SelectField, TextAreaField, TextField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';

const DOCUMENT_TYPES: readonly { value: TechnicalDocumentType; label: string }[] = [
  { value: 'machine_manual', label: 'Machine manual' },
  { value: 'electrical_diagram', label: 'Electrical diagram' },
  { value: 'service_manual', label: 'Service manual' },
  { value: 'safety_procedure', label: 'Safety procedure' },
  { value: 'work_procedure', label: 'Work procedure' },
  { value: 'datasheet', label: 'Datasheet' },
];

/**
 * Technician upload.
 *
 * A technician who has a manual the office does not can submit it, but it does
 * not become official reference material until a Master approves it — that is
 * `addDocument`'s decision, made from the actor's role, not this dialog's.
 */
export const UploadDocumentDialog = ({
  open,
  onClose,
  onUploaded,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onUploaded: () => void;
}) => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const goesLiveImmediately = can(currentUser.role, 'library.manage');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [documentType, setDocumentType] = useState<TechnicalDocumentType>('machine_manual');
  const [manufacturer, setManufacturer] = useState('');
  const [machineModel, setMachineModel] = useState('');
  const [fileName, setFileName] = useState('');

  const submit = async (): Promise<void> => {
    const ok = await operation.run((context) =>
      addDocument(context, {
        name,
        description,
        documentType,
        manufacturer,
        machineModel,
        version: '1.0',
        fileName,
        pageCount: 12,
        tags: [],
      }),
    );
    if (ok) {
      setName('');
      setDescription('');
      setManufacturer('');
      setMachineModel('');
      setFileName('');
      onUploaded();
    }
  };

  return (
    <Modal
      open={open}
      title="Upload a document"
      description={
        goesLiveImmediately
          ? 'Published to the library immediately.'
          : 'Submitted to the office. It becomes official reference material once a Master approves it.'
      }
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={operation.running}>
            Cancel
          </Button>
          <Button onClick={submit} loading={operation.running}>
            {goesLiveImmediately ? 'Publish document' : 'Submit for approval'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {operation.error !== null && (
          <RuleViolationNotice
            title="The document could not be submitted"
            message={operation.error}
            violations={operation.violations}
          />
        )}

        <div className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-4 py-3 text-sm text-amber-eje-700">
          <span className="font-semibold">Demo mode:</span> no file is uploaded. The record is
          created exactly as the production uploader will create it, and the preview is marked as
          simulated.
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Document name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            containerClassName="sm:col-span-2"
          />
          <TextAreaField
            label="What is it, and when would a technician need it?"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            containerClassName="sm:col-span-2"
          />
          <SelectField
            label="Document type"
            value={documentType}
            onChange={(event) => setDocumentType(event.target.value as TechnicalDocumentType)}
            options={DOCUMENT_TYPES.map((type) => ({ value: type.value, label: type.label }))}
          />
          <TextField
            label="Manufacturer"
            value={manufacturer}
            onChange={(event) => setManufacturer(event.target.value)}
          />
          <TextField
            label="Machine model"
            value={machineModel}
            onChange={(event) => setMachineModel(event.target.value)}
          />
          <TextField
            label="File name"
            value={fileName}
            onChange={(event) => setFileName(event.target.value)}
            placeholder="fanuc-0i-mf-alarm-list.pdf"
          />
        </div>
      </div>
    </Modal>
  );
};
