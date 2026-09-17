import type { Cents, IsoDate, IsoDateTime } from '@/domain';

/** Presentation formatting. Locale is fixed to en-ZA for the South African market. */

const LOCALE = 'en-ZA';

const currencyFormatter = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'ZAR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const formatCurrency = (cents: Cents): string => currencyFormatter.format(cents / 100);

export const formatNumber = (value: number, maximumFractionDigits = 2): string =>
  new Intl.NumberFormat(LOCALE, { maximumFractionDigits }).format(value);

export const formatHours = (hours: number): string => `${formatNumber(hours, 2)} hrs`;

export const formatKilometres = (km: number): string => `${formatNumber(km, 1)} km`;

const parse = (value: IsoDate | IsoDateTime): Date =>
  value.length === 10 ? new Date(`${value}T00:00:00`) : new Date(value);

export const formatDate = (value: IsoDate | IsoDateTime | null): string => {
  if (value === null || value.length === 0) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(parse(value));
};

export const formatDateTime = (value: IsoDateTime | null): string => {
  if (value === null || value.length === 0) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parse(value));
};

export const formatTime = (value: IsoDateTime | null): string => {
  if (value === null || value.length === 0) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parse(value));
};

/** "3 hours ago", "Yesterday", "12 Mar 2026" — whichever reads best. */
export const formatRelative = (value: IsoDateTime | null): string => {
  if (value === null || value.length === 0) return '—';
  const then = parse(value).getTime();
  const diffMinutes = Math.round((Date.now() - then) / 60000);

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

export const isOverdue = (scheduledDate: IsoDate | null): boolean => {
  if (scheduledDate === null) return false;
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return parse(scheduledDate).getTime() < startOfToday.getTime();
};

export const isToday = (scheduledDate: IsoDate | null): boolean => {
  if (scheduledDate === null) return false;
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return parse(scheduledDate).getTime() === startOfToday.getTime();
};
