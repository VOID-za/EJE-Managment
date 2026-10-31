'use client';

import { useState } from 'react';
import { jobs } from '@/api/endpoints';

/**
 * One photograph in the on-screen job card's grid.
 *
 * It was a grey box with the word "Photograph" in it, whatever the technician
 * had uploaded. Now it is the photograph, read through the same authorised
 * media route as the Photographs tab, fitted into the 4:3 cell at its own
 * proportions — the same cell the PDF draws.
 *
 * When there is nothing to draw — a demonstration photograph with no file, or a
 * file the browser cannot load — the cell says so in words, as the PDF does,
 * rather than showing an empty frame that reads as a picture.
 */
export const DocumentPhoto = ({
  jobId,
  photo,
  simulated,
}: {
  readonly jobId: string;
  readonly photo: { readonly id: string; readonly caption: string; readonly fileName: string };
  readonly simulated: boolean;
}) => {
  const [failed, setFailed] = useState(false);
  const missing = simulated || failed;

  return (
    <div
      className="flex aspect-4/3 items-center justify-center overflow-hidden rounded border border-steel-200 bg-steel-100"
      data-testid="document-photo"
      data-photo-state={missing ? 'unavailable' : 'image'}
    >
      {missing ? (
        <div className="px-2 text-center text-xs text-steel-500">
          <p className="font-semibold">Photograph not shown</p>
          <p className="mt-0.5 text-steel-400">
            {simulated
              ? 'Demonstration photograph: there is no image file behind it.'
              : 'The image file could not be loaded.'}
          </p>
          <p className="mt-0.5 break-all text-steel-400">{photo.fileName}</p>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- an authenticated API route, not an optimisable asset: the optimiser would fetch it server-side without the session cookie
        <img
          src={jobs.mediaUrl(jobId, photo.id)}
          alt={photo.caption.trim().length > 0 ? photo.caption : photo.fileName}
          className="size-full object-contain"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
};
