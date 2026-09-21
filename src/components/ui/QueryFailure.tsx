'use client';

import type { ApiErrorCode } from '@/api/client';
import { describeFailure } from './request-failure';
import { AccessDeniedState, EmptyState, ErrorState } from './States';

/**
 * What a screen draws when its read did not come back.
 *
 * ONE COMPONENT, so the seventeen screens that used to render
 * `<ErrorState message={query.error} />` for every outcome cannot each decide
 * differently. `describeFailure` chooses the words and whether a retry is
 * honest; this only draws them.
 *
 * A REFUSAL AND A FAULT ARE DIFFERENT PANELS. That is the whole point: a 403
 * says what it is and offers no retry, and everything the server could not do
 * keeps the red panel and the "Try again" it has always had. Nothing here
 * changes what was requested or asks again — the request is over.
 */
export const QueryFailure = ({
  code,
  message,
  onRetry,
}: {
  readonly code: ApiErrorCode | null;
  readonly message: string | null;
  readonly onRetry?: () => void;
}) => {
  // No code means the failure did not come from the API at all — a loader that
  // threw on its own. That is a fault, and is presented as one.
  const failure = describeFailure(code ?? 'internal_error', message);

  if (failure.kind === 'denied') {
    return <AccessDeniedState title={failure.title} message={failure.message} />;
  }

  /*
   * Not found is neither a refusal nor a fault, and it is already how the API
   * answers for a record this actor may not know exists — so it gets the plain
   * empty panel the screens use for "there is nothing here", not a lock and not
   * a red alert.
   */
  if (failure.kind === 'missing') {
    return <EmptyState title={failure.title} description={failure.message} />;
  }

  return (
    <ErrorState
      title={failure.title}
      message={failure.message}
      {...(failure.retryable && onRetry !== undefined ? { onRetry } : {})}
    />
  );
};
