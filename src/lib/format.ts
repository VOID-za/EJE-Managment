import type { Cents, IsoDate, IsoDateTime } from '@/domain';

/**
 * Presentation formatting.
 *
 * These functions are deliberately implemented without `Intl`. The ICU data
 * bundled with Node and with the browser disagree on `en-ZA` — Node renders
 * R 3 800,00 while Chromium renders R 3,800.00 — which would make a server
 * render and a client render of the same job card disagree, and would make the
 * printed document depend on whichever runtime happened to produce it.
 *
 * Money appears on a signed customer document, so the format is pinned here and
 * is identical everywhere. The separators below are the single place to change
 * if EJE prefers a different convention.
 */

/** South African convention: space as thousands separator, comma as decimal. */
const THOUSANDS_SEPARATOR = ' '; // non-breaking space, so amounts never wrap
const DECIMAL_SEPARATOR = ',';
const CURRENCY_SYMBOL = 'R';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const groupDigits = (digits: string): string => {
  let result = '';
  for (let index = digits.length; index > 0; index -= 3) {
    const start = Math.max(0, index - 3);
    result = digits.slice(start, index) + (result.length > 0 ? THOUSANDS_SEPARATOR + result : '');
  }
  return result.length > 0 ? result : '0';
};

export const formatCurrency = (cents: Cents): string => {
  const negative = cents < 0;
  const absolute = Math.abs(Math.round(cents));
  const whole = Math.floor(absolute / 100);
  const fraction = `${absolute % 100}`.padStart(2, '0');
  const body = `${CURRENCY_SYMBOL}${THOUSANDS_SEPARATOR}${groupDigits(`${whole}`)}${DECIMAL_SEPARATOR}${fraction}`;
  return negative ? `-${body}` : body;
};

export const formatNumber = (value: number, maximumFractionDigits = 2): string => {
  if (!Number.isFinite(value)) return '—';
  const negative = value < 0;
  const absolute = Math.abs(value);
  const rounded = absolute.toFixed(maximumFractionDigits);
  const [wholePart = '0', fractionPart] = rounded.split('.');

  // Trailing zeroes are noise on quantities such as hours and kilometres.
  const trimmed = fractionPart === undefined ? '' : fractionPart.replace(/0+$/, '');
  const body =
    groupDigits(wholePart) + (trimmed.length > 0 ? DECIMAL_SEPARATOR + trimmed : '');
  return negative ? `-${body}` : body;
};

export const formatHours = (hours: number): string => `${formatNumber(hours, 2)} hrs`;

export const formatKilometres = (km: number): string => `${formatNumber(km, 1)} km`;

const parse = (value: IsoDate | IsoDateTime): Date =>
  value.length === 10 ? new Date(`${value}T00:00:00`) : new Date(value);

const pad = (value: number): string => `${value}`.padStart(2, '0');

export const formatDate = (value: IsoDate | IsoDateTime | null): string => {
  if (value === null || value.length === 0) return '—';
  const date = parse(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${pad(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};

export const formatTime = (value: IsoDateTime | null): string => {
  if (value === null || value.length === 0) return '—';
  const date = parse(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const formatDateTime = (value: IsoDateTime | null): string => {
  if (value === null || value.length === 0) return '—';
  const date = parse(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${formatDate(value)} ${formatTime(value)}`;
};

/** "3 hours ago", "Yesterday", "12 Mar 2026" — whichever reads best. */
export const formatRelative = (value: IsoDateTime | null): string => {
  if (value === null || value.length === 0) return '—';
  const then = parse(value).getTime();
  if (Number.isNaN(then)) return '—';

  const diffMinutes = Math.round((Date.now() - then) / 60000);
  if (diffMinutes < 0) return formatDateTime(value);
  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes} min ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;

  const diffDays = Math.round(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;

  return formatDate(value);
};

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, 0)} KB`;
  return `${formatNumber(bytes / (1024 * 1024), 1)} MB`;
};

const startOfToday = (): number => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
};

export const isOverdue = (scheduledDate: IsoDate | null): boolean => {
  if (scheduledDate === null) return false;
  return parse(scheduledDate).getTime() < startOfToday();
};

export const isToday = (scheduledDate: IsoDate | null): boolean => {
  if (scheduledDate === null) return false;
  return parse(scheduledDate).getTime() === startOfToday();
};
