'use client';

import { useState } from 'react';
import { isJobAtOrPastCompletion, requiresDeliveryNote } from '@/domain';
import type { JobView } from '@/application/job-view';
import { jobs } from '@/api/endpoints';
import { Button, Icon } from '@/components/ui';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { buildDeliveryNoteModel } from '@/lib/job-card/delivery-note';
import { DeliveryNoteDocument } from './DeliveryNoteDocument';

/**
 * THE COURIER'S DELIVERY NOTE. PARTS-03, PARTS-04.
 *
 * Offered on a courier collection once the work is finished, beside — never
 * instead of — the priced job card, so the office prints the two
 * independently. The PDF comes from the server, which records that it was
 * produced; the on-screen copy (for tablets) is drawn from the same model. It
 * has no prices to show.
 */
export const DeliveryNoteButton = ({ view }: { readonly view: JobView }) => {
  const [open, setOpen] = useState(false);
  if (!requiresDeliveryNote(view.job) || !isJobAtOrPastCompletion(view.job.status)) return null;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        leadingIcon={<Icon name="document" className="size-4" />}
        onClick={() => setOpen(true)}
        data-testid="delivery-note-button"
      >
        Delivery note
      </Button>
      <DocumentPreviewDialog
        open={open}
        title={`${view.job.jobNumber} — Delivery Note`}
        description="For the courier: the goods and quantities, no prices. The priced job card is separate."
        loadPdf={() => jobs.deliveryNote(view.job.id)}
        renderHtml={() => <DeliveryNoteDocument model={buildDeliveryNoteModel(view, new Date().toISOString())} />}
        onClose={() => setOpen(false)}
      />
    </>
  );
};
