import { supabaseAdmin } from '../../config/supabaseAdmin';
import { NotifyInput } from '../notifications/notifications.types';
import { SupportStatus, SupportTicketRecord } from './support.types';

const STATUS_COPY: Record<SupportStatus, { bn: string; en: string }> = {
  open: { bn: 'টিকিট আবার খোলা হয়েছে', en: 'Ticket reopened' },
  in_progress: { bn: 'টিকিটটি দেখা হচ্ছে', en: 'Ticket in progress' },
  awaiting_student: { bn: 'আপনার উত্তরের অপেক্ষায়', en: 'Waiting for your reply' },
  resolved: { bn: 'টিকিট সমাধান হয়েছে', en: 'Ticket resolved' },
  closed: { bn: 'টিকিট বন্ধ হয়েছে', en: 'Ticket closed' },
};

const loadStaffIds = async (): Promise<string[]> => {
  const { data, error } = await supabaseAdmin
    .from('user_roles')
    .select('user_id')
    .in('role', ['admin', 'super_admin'])
    .eq('is_active', true);

  if (error) {
    console.error('[support] staff lookup failed:', error.message);
    return [];
  }

  return Array.from(
    new Set(
      (data ?? [])
        .map((row) => String(row.user_id ?? ''))
        .filter((id) => id.length > 0)
    )
  );
};

/**
 * Notifications are best-effort: a delivery failure must never fail the
 * support request that triggered it.
 */
const send = async (input: NotifyInput): Promise<void> => {
  try {
    const { notify } = await import('../notifications/notifications.service');
    await notify(input);
  } catch (error) {
    console.error('[support] notification failed:', error);
  }
};

export const notifyStaffOfNewTicket = async (
  ticket: SupportTicketRecord,
  studentName: string
): Promise<void> => {
  const staffIds = await loadStaffIds();
  if (staffIds.length === 0) return;

  await send({
    userIds: staffIds,
    type: 'social',
    eventCode: 'support_ticket_created',
    title: { bn: 'নতুন সাপোর্ট টিকিট', en: 'New support ticket' },
    body: {
      bn: `${ticket.ticket_ref}: ${ticket.subject} — ${studentName}`,
      en: `${ticket.ticket_ref}: ${ticket.subject} — ${studentName}`,
    },
    actionLink: `/support/${ticket.id}`,
    priority: 'high',
    channels: ['in_app'],
    dedupeKey: `support:new:${ticket.id}`,
    metaData: { ticket_id: ticket.id, ticket_ref: ticket.ticket_ref },
  });
};

export const notifyStudentOfReply = async (
  ticket: SupportTicketRecord,
  messageId: string
): Promise<void> => {
  await send({
    userIds: ticket.user_id,
    type: 'social',
    eventCode: 'support_ticket_reply',
    title: { bn: 'সাপোর্ট টিম উত্তর দিয়েছে', en: 'Support replied to your ticket' },
    body: {
      bn: `${ticket.ticket_ref}: ${ticket.subject}`,
      en: `${ticket.ticket_ref}: ${ticket.subject}`,
    },
    actionLink: `/support/${ticket.id}`,
    priority: 'high',
    channels: ['in_app', 'push'],
    dedupeKey: `support:reply:${messageId}`,
    metaData: { ticket_id: ticket.id, ticket_ref: ticket.ticket_ref },
  });
};

export const notifyStudentOfStatus = async (
  ticket: SupportTicketRecord,
  status: SupportStatus
): Promise<void> => {
  if (status === 'open') return;

  const copy = STATUS_COPY[status];

  await send({
    userIds: ticket.user_id,
    type: 'social',
    eventCode: 'support_ticket_status',
    title: { bn: copy.bn, en: copy.en },
    body: {
      bn: `${ticket.ticket_ref}: ${ticket.subject}`,
      en: `${ticket.ticket_ref}: ${ticket.subject}`,
    },
    actionLink: `/support/${ticket.id}`,
    channels: ['in_app'],
    dedupeKey: `support:status:${ticket.id}:${status}:${ticket.updated_at}`,
    metaData: { ticket_id: ticket.id, ticket_ref: ticket.ticket_ref, status },
  });
};

/** Student replies put the ticket back in the staff queue. */
export const notifyStaffOfStudentReply = async (
  ticket: SupportTicketRecord,
  messageId: string
): Promise<void> => {
  const staffIds = await loadStaffIds();
  if (staffIds.length === 0) return;

  await send({
    userIds: staffIds,
    type: 'social',
    eventCode: 'support_ticket_student_reply',
    title: { bn: 'শিক্ষার্থীর নতুন উত্তর', en: 'New student reply' },
    body: {
      bn: `${ticket.ticket_ref}: ${ticket.subject}`,
      en: `${ticket.ticket_ref}: ${ticket.subject}`,
    },
    actionLink: `/support/${ticket.id}`,
    channels: ['in_app'],
    dedupeKey: `support:student-reply:${messageId}`,
    metaData: { ticket_id: ticket.id, ticket_ref: ticket.ticket_ref },
  });
};
