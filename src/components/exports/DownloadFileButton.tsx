'use client';

import { useState } from 'react';
import { Button, Icon } from '@/components/ui';
import { apiDownload, ApiRequestError } from '@/api/client';
import { downloadBytes } from '@/lib/download';

/**
 * Download a file the server builds or holds. MASTER SCOPE SEARCH-4, LIB-5.
 *
 * Two callers, one behaviour: the spreadsheet exports of the Jobs list and the
 * closed-job archive, and the technical library's stored documents. Both are an
 * authenticated GET that answers with a file or refuses in JSON, which is the
 * whole reason this is not an `<a href>`.
 *
 * WHY IT IS A FETCH AND NOT A LINK. A plain `<a href>` to the export route
 * would work on the happy path and would be unreadable on every other one: a
 * refusal — a role that may not have the file, filters that match more rows
 * than one file may carry — is JSON with a 4xx on it, and a browser following
 * a link would simply show the technician that JSON. So the file is fetched,
 * and a refusal is rendered where the person is standing, in the words the
 * server used.
 *
 * THE SCREEN DECIDES NOTHING ABOUT THE CONTENT. It passes the path of its own
 * export route with its own filters on it; what comes back is whatever that
 * route's authorised read produced. There is no client-side assembly of a file
 * here, and no second copy of a filter — see `exports.ts`.
 */
export const DownloadFileButton = ({
  href,
  fallbackName,
  label = 'Download',
  disabled = false,
  testId = 'export-csv',
}: {
  /** The export route, with this screen's current filters already on it. */
  readonly href: string;
  /** Used only if the server sent no file name at all. */
  readonly fallbackName: string;
  readonly label?: string;
  readonly disabled?: boolean;
  /** The button's test id; its failure line gets `-failure` after it. */
  readonly testId?: string;
}) => {
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setWorking(true);
    setFailure(null);
    try {
      const file = await apiDownload(href, fallbackName);
      // The server's bytes, handed over unchanged — BOM included, which is what
      // makes Excel read the file as UTF-8.
      downloadBytes(file.bytes, file.fileName, file.contentType);
    } catch (cause) {
      setFailure(
        cause instanceof ApiRequestError
          ? [cause.message, ...cause.violations.map((violation) => violation.message)].join(' ')
          : 'That export could not be produced.',
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
        disabled={disabled}
        leadingIcon={<Icon name="download" className="size-4" />}
        onClick={() => void run()}
        data-testid={testId}
      >
        {label}
      </Button>
      {failure !== null && (
        <p className="text-xs text-signal-600" role="status" data-testid={`${testId}-failure`}>
          {failure}
        </p>
      )}
    </div>
  );
};
