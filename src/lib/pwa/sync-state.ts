/**
 * THE FIVE SYNC STATES, NAMED ONCE. OFF-8, completed 27 October 2026.
 *
 * The register asks for "synced / saved locally / syncing / waiting / action
 * required". The tablet already distinguished every one of them — it said
 * *Not sent*, *Sending…*, *Refused* and *With the office*, and a synced row
 * left the panel — but in its own words, so a technician and the office could
 * not use one vocabulary. This is the one mapping both queue panels use.
 *
 *   - SAVED LOCALLY — held on this tablet with no connection to send it.
 *   - WAITING — held, there is a connection, and it is queued behind the flush.
 *   - SYNCING — its own request is open right now (in memory, never stored:
 *     see `markSending`).
 *   - ACTION REQUIRED — the server refused it; a person decides (BD-15 refers
 *     it to the office straight away, after which it is WITH THE OFFICE).
 *   - SYNCED — the server has it, and the row leaves the tablet; with nothing
 *     left, the panel itself goes. Never a row that stays saying "done".
 *
 * Every held label keeps the words "Not sent": that is the fact a technician
 * must never be able to misread, and what the browser smoke suite holds the
 * screen to.
 */
export type SyncState = 'saved_locally' | 'waiting' | 'syncing' | 'action_required' | 'with_office';

export const syncStateOf = (input: {
  readonly state: 'pending' | 'conflict' | 'referred';
  readonly sending: boolean;
  readonly online: boolean;
}): SyncState => {
  if (input.state === 'conflict') return 'action_required';
  if (input.state === 'referred') return 'with_office';
  if (input.sending) return 'syncing';
  return input.online ? 'waiting' : 'saved_locally';
};

export const SYNC_LABEL: Readonly<Record<SyncState, string>> = {
  saved_locally: 'Saved locally · Not sent',
  waiting: 'Waiting to send · Not sent',
  syncing: 'Syncing…',
  action_required: 'Refused · Action required',
  with_office: 'With the office',
};

export const SYNC_TONE: Readonly<Record<SyncState, 'amber' | 'blue' | 'red'>> = {
  saved_locally: 'amber',
  waiting: 'amber',
  syncing: 'blue',
  action_required: 'red',
  with_office: 'blue',
};
