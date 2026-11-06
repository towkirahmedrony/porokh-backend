/**
 * Pure helpers behind the admin dashboard.
 *
 * Everything here is deterministic and database-free so the date windows,
 * trend maths and payment grouping can be unit tested without a Supabase
 * connection. Buckets are keyed in Asia/Dhaka because "today" for the
 * platform means the Dhaka calendar day, not the UTC day.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_RANGE_MS = 366 * DAY_MS;

export type DashboardBucket = 'hour' | 'day';

export interface DashboardRange {
  from: Date;
  to: Date;
  fromIso: string;
  toIso: string;
  bucket: DashboardBucket;
  days: number;
}

export interface DatePoint {
  key: string;
  value: number;
}

export interface PaymentAmountRow {
  status?: string | null;
  amount?: number | string | null;
}

export interface PaymentSummary {
  gross: number;
  confirmed: number;
  pending: number;
  failed: number;
  confirmedCount: number;
  pendingCount: number;
  failedCount: number;
}

export class DashboardRangeError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'DashboardRangeError';
  }
}

const DHK_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
});

const partsOf = (value: Date): { year: string; month: string; day: string; hour: string } => {
  const parts = DHK_FORMATTER.formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  const hour = read('hour');

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Intl renders midnight as 24 in some engines.
    hour: hour === '24' ? '00' : hour,
  };
};

const toDate = (value: Date | string): Date | null => {
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
};

/** `2026-11-06` for a Dhaka-local calendar day. */
export const dhakaDayKey = (value: Date | string): string => {
  const date = toDate(value);
  if (!date) return '';
  const { year, month, day } = partsOf(date);
  return `${year}-${month}-${day}`;
};

/** `2026-11-06T14` for a Dhaka-local hour bucket. */
export const dhakaHourKey = (value: Date | string): string => {
  const date = toDate(value);
  if (!date) return '';
  const { year, month, day, hour } = partsOf(date);
  return `${year}-${month}-${day}T${hour}`;
};

/** 0–23 Dhaka hour, used for the peak-activity insight. */
export const dhakaHourOfDay = (value: Date | string): number | null => {
  const date = toDate(value);
  if (!date) return null;
  return Number(partsOf(date).hour);
};

/** First instant of the Dhaka calendar day containing `value`. */
export const dhakaDayStart = (value: Date | string): Date => {
  const key = dhakaDayKey(value);
  return new Date(`${key}T00:00:00+06:00`);
};

/** First instant of the Dhaka calendar month containing `value`. */
export const dhakaMonthStart = (value: Date | string): Date => {
  const key = dhakaDayKey(value);
  return new Date(`${key.slice(0, 7)}-01T00:00:00+06:00`);
};

/**
 * Validates the dashboard window. The client sends explicit ISO bounds; a
 * missing pair falls back to the last seven days so the endpoint always has a
 * usable range.
 */
export const parseDashboardRange = (
  fromRaw?: string | null,
  toRaw?: string | null,
  now: Date = new Date()
): DashboardRange => {
  const hasFrom = typeof fromRaw === 'string' && fromRaw.trim() !== '';
  const hasTo = typeof toRaw === 'string' && toRaw.trim() !== '';

  if (hasFrom !== hasTo) {
    throw new DashboardRangeError('Both from and to are required for a custom range');
  }

  let from: Date;
  let to: Date;

  if (hasFrom && hasTo) {
    const parsedFrom = toDate(fromRaw as string);
    const parsedTo = toDate(toRaw as string);

    if (!parsedFrom || !parsedTo) {
      throw new DashboardRangeError('from and to must be valid ISO timestamps');
    }

    from = parsedFrom;
    to = parsedTo;
  } else {
    to = new Date(now);
    from = new Date(now.getTime() - 7 * DAY_MS);
  }

  const span = to.getTime() - from.getTime();

  if (span <= 0) {
    throw new DashboardRangeError('to must be later than from');
  }

  if (span > MAX_RANGE_MS) {
    throw new DashboardRangeError('The selected range cannot be longer than 366 days');
  }

  return {
    from,
    to,
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    bucket: span <= 48 * HOUR_MS ? 'hour' : 'day',
    days: Math.max(1, Math.ceil(span / DAY_MS)),
  };
};

/** The equally sized window immediately before the selected range. */
export const previousRange = (range: DashboardRange): { fromIso: string; toIso: string } => {
  const span = range.to.getTime() - range.from.getTime();
  return {
    fromIso: new Date(range.from.getTime() - span).toISOString(),
    toIso: range.fromIso,
  };
};

/** Bucket keys covering the range, de-duplicated and ordered. */
export const buildBucketKeys = (range: DashboardRange): string[] => {
  const step = range.bucket === 'hour' ? HOUR_MS : DAY_MS;
  const keys: string[] = [];

  for (let cursor = range.from.getTime(); cursor < range.to.getTime(); cursor += step) {
    const date = new Date(cursor);
    keys.push(range.bucket === 'hour' ? dhakaHourKey(date) : dhakaDayKey(date));
  }

  if (keys.length === 0) {
    keys.push(range.bucket === 'hour' ? dhakaHourKey(range.from) : dhakaDayKey(range.from));
  }

  return Array.from(new Set(keys));
};

/** Counts timestamps into pre-built buckets, leaving empty buckets at zero. */
export const bucketSeries = (
  keys: string[],
  timestamps: Array<string | null | undefined>,
  keyOf: (iso: string) => string
): DatePoint[] => {
  const index = new Map(keys.map((key, position) => [key, position]));
  const counts = keys.map(() => 0);

  for (const timestamp of timestamps) {
    if (!timestamp) continue;
    const position = index.get(keyOf(timestamp));
    if (position !== undefined) counts[position] += 1;
  }

  return keys.map((key, position) => ({ key, value: counts[position] }));
};

/** Sums an amount column into pre-built buckets. */
export const sumBucketSeries = <T>(
  keys: string[],
  rows: T[],
  keyOf: (row: T) => string,
  amountOf: (row: T) => number
): DatePoint[] => {
  const index = new Map(keys.map((key, position) => [key, position]));
  const totals = keys.map(() => 0);

  for (const row of rows) {
    const position = index.get(keyOf(row));
    if (position === undefined) continue;
    const amount = amountOf(row);
    if (Number.isFinite(amount)) totals[position] += amount;
  }

  return keys.map((key, position) => ({ key, value: roundMoney(totals[position]) }));
};

export const roundMoney = (value: number): number => Math.round(value * 100) / 100;

/**
 * Percentage change against the comparison value. `null` means there is no
 * meaningful baseline (previous = 0 while current > 0), so the UI can say
 * "new" instead of inventing an infinite percentage.
 */
export const calculateTrend = (current: number, previous: number | null): number | null => {
  if (previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return Number((((current - previous) / previous) * 100).toFixed(1));
};

export const percentOf = (part: number, total: number): number | null => {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return Number(((part / total) * 100).toFixed(1));
};

/**
 * Revenue per status. Each request row is counted exactly once, which keeps
 * gross revenue free of the double counting a payment/subscription join would
 * introduce.
 */
export const summarizePayments = (rows: PaymentAmountRow[]): PaymentSummary => {
  const summary: PaymentSummary = {
    gross: 0,
    confirmed: 0,
    pending: 0,
    failed: 0,
    confirmedCount: 0,
    pendingCount: 0,
    failedCount: 0,
  };

  for (const row of rows) {
    const parsed = Number(row.amount ?? 0);
    const amount = Number.isFinite(parsed) ? parsed : 0;
    summary.gross += amount;

    if (row.status === 'paid') {
      summary.confirmed += amount;
      summary.confirmedCount += 1;
    } else if (row.status === 'pending') {
      summary.pending += amount;
      summary.pendingCount += 1;
    } else if (row.status === 'failed') {
      summary.failed += amount;
      summary.failedCount += 1;
    }
  }

  summary.gross = roundMoney(summary.gross);
  summary.confirmed = roundMoney(summary.confirmed);
  summary.pending = roundMoney(summary.pending);
  summary.failed = roundMoney(summary.failed);

  return summary;
};

/** Weighted score percentage across attempts, skipping malformed rows. */
export const averageScorePercent = (
  rows: Array<{ score?: number | string | null; total_marks?: number | string | null }>
): number | null => {
  let score = 0;
  let total = 0;

  for (const row of rows) {
    const rowScore = Number(row.score ?? 0);
    const rowTotal = Number(row.total_marks ?? 0);
    if (!Number.isFinite(rowScore) || !Number.isFinite(rowTotal) || rowTotal <= 0) continue;
    score += rowScore;
    total += rowTotal;
  }

  return percentOf(score, total);
};
