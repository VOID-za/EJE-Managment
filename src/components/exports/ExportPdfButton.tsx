'use client';

import { useState } from 'react';
import { Button, Icon } from '@/components/ui';
import { apiDownload, ApiRequestError } from '@/api/client';
import { shareOrDownload } from '@/lib/share-file';

/**
 * EXPORT PDF — the server's file, handed to the device's share sheet. PAY-01.
 *
 * The same authorised GET as Download PDF (`DownloadFileButton`), so the bytes
 * and the file name are the server's; only what happens to them differs. See
 * `share-file.ts` for why a browser without sharing gets a download.
 */
export const ExportPdfButton = ({
  href,
  fallbackName,
  label = 'Export PDF',
  testId = 'export-pdf',
}: {
  readonly href: string;
  readonly fallbackName: string;
  readonly label?: string;
  readonly testId?: string;
}) => {
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setWorking(true);
    setMessage(null);
    try {
      const file = await apiDownload(href, fallbackName);
      const outcome = await shareOrDownload(file.bytes, file.fileName, file.contentType);
      if (outcome === 'downloaded') setMessage(`This browser cannot share files, so ${file.fileName} was downloaded instead.`);
      if (outcome === 'shared') setMessage(`${file.fileName} handed to the app you chose.`);
    } catch (cause) {
      setMessage(
        cause instanceof ApiRequestError
          ? [cause.message, ...cause.violations.map((violation) => violation.message)].join(' ')
          : 'That file could not be produced.',
      );
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="secondary"
        size="sm"
        loading={working}
        leadingIcon={<Icon name="document" className="size-4" />}
        onClick={() => void run()}
        data-testid={testId}
      >
        {label}
      </Button>
      {message !== null && (
        <p className="text-xs text-steel-600" role="status" data-testid={`${testId}-message`}>
          {message}
        </p>
      )}
    </div>
  );
};
