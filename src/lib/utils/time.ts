/**
 * Bangladesh time helpers.
 *
 * Daily freemium quotas reset at midnight in Asia/Dhaka. Dhaka has used a
 * fixed UTC+6 offset without daylight saving since 2009, so a fixed offset is
 * exact here and avoids depending on the server's local timezone (production
 * containers run in UTC, which would otherwise shift the boundary by 6 hours).
 */
export const DHAKA_UTC_OFFSET_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant (UTC) at which the current Asia/Dhaka day started. */
export const startOfDhakaDay = (now: Date = new Date()): Date =>
  new Date(Math.floor((now.getTime() + DHAKA_UTC_OFFSET_MS) / DAY_MS) * DAY_MS - DHAKA_UTC_OFFSET_MS);

/** The instant (UTC) at which the current Asia/Dhaka day ends (next midnight). */
export const endOfDhakaDay = (now: Date = new Date()): Date =>
  new Date(startOfDhakaDay(now).getTime() + DAY_MS);

export const startOfDhakaDayIso = (now?: Date): string => startOfDhakaDay(now).toISOString();

export const endOfDhakaDayIso = (now?: Date): string => endOfDhakaDay(now).toISOString();

/** The Asia/Dhaka calendar day (YYYY-MM-DD) containing `now`. */
export const dhakaDayKey = (now: Date = new Date()): string =>
  new Date(startOfDhakaDay(now).getTime() + DHAKA_UTC_OFFSET_MS).toISOString().slice(0, 10);
