import { SupportNotFoundError } from './support.errors';
import {
  SUPPORT_STATUSES,
  SupportStatus,
} from './support.types';

/**
 * Allowed status moves. The API validates every transition with this table;
 * the database only checks that the stored value is one of the known statuses.
 */
const STATUS_TRANSITIONS: Record<SupportStatus, readonly SupportStatus[]> = {
  open: ['in_progress', 'awaiting_student', 'resolved', 'closed'],
  in_progress: ['open', 'awaiting_student', 'resolved', 'closed'],
  awaiting_student: ['open', 'in_progress', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: ['open'],
};

export const isSupportStatus = (value: unknown): value is SupportStatus =>
  typeof value === 'string' && (SUPPORT_STATUSES as readonly string[]).includes(value);

export const canTransitionStatus = (
  from: SupportStatus,
  to: SupportStatus
): boolean => STATUS_TRANSITIONS[from].includes(to);

/**
 * A student may write to a ticket until it is closed. Replying to a resolved
 * ticket reopens it, which is the "reopen where appropriate" path.
 */
export const canStudentReply = (status: SupportStatus): boolean => status !== 'closed';

export const canStudentReopen = (status: SupportStatus): boolean => status === 'resolved';

/** Status after a student reply. Any staff-facing state returns to the queue. */
export const studentReplyStatus = (status: SupportStatus): SupportStatus => {
  if (status === 'resolved' || status === 'awaiting_student') return 'open';
  return status;
};

/** Status after a staff reply unless the request sets one explicitly. */
export const adminReplyStatus = (status: SupportStatus): SupportStatus => {
  if (status === 'resolved' || status === 'closed') return 'in_progress';
  return 'awaiting_student';
};

/** Statuses that are still considered open work for the admin queue. */
export const ACTIVE_SUPPORT_STATUSES: readonly SupportStatus[] = [
  'open',
  'in_progress',
  'awaiting_student',
];

/**
 * A ticket that is not found is reported as 404 rather than 403 so a student
 * cannot use the response to confirm that somebody else's ticket exists.
 */
export const assertTicketExists = <T>(ticket: T | null): T => {
  if (!ticket) throw new SupportNotFoundError();
  return ticket;
};
