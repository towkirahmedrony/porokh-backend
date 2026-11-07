import { supabaseAdmin } from '../../config/supabaseAdmin';
import {
  SUPPORT_ERROR_CODES,
  SupportConflictError,
  SupportValidationError,
} from './support.errors';
import {
  ACTIVE_SUPPORT_STATUSES,
  adminReplyStatus,
  assertTicketExists,
  canStudentReopen,
  canStudentReply,
  canTransitionStatus,
  studentReplyStatus,
} from './support.policy';
import { parseSupportAttachments, uploadSupportAttachments } from './support.attachments';
import {
  notifyStaffOfNewTicket,
  notifyStaffOfStudentReply,
  notifyStudentOfReply,
  notifyStudentOfStatus,
} from './support.notifications';
import {
  CreateSupportTicketInput,
  SupportListQuery,
} from './support.validation';
import {
  SupportAgent,
  SupportAttachment,
  SupportMessageRecord,
  SupportPriority,
  SupportStats,
  SupportStatus,
  SupportTicketDetail,
  SupportTicketListResult,
  SupportTicketRecord,
  SupportTicketSummary,
} from './support.types';

// PostgREST select strings with FK aliases are not understood by the generated
// table types, so the query builder is used untyped here.
const admin = supabaseAdmin as any;

const TICKET_COLUMNS = [
  'id',
  'ticket_ref',
  'user_id',
  'category',
  'subject',
  'status',
  'priority',
  'assigned_to',
  'context_question_id',
  'context_exam_id',
  'context_screen',
  'last_message_at',
  'resolved_at',
  'resolved_by',
  'closed_at',
  'created_at',
  'updated_at',
].join(',');

const MESSAGE_COLUMNS =
  'id,ticket_id,author_id,author_role,body,attachments,created_at';

const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

const normalizeAttachments = (value: unknown): SupportAttachment[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is SupportAttachment =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as SupportAttachment).url === 'string'
      )
    : [];

const normalizeMessages = (
  rows: Array<SupportMessageRecord & { author?: unknown }> | null
): SupportTicketDetail['messages'] =>
  (rows ?? []).map((row) => ({
    ...row,
    attachments: normalizeAttachments(row.attachments),
    author: Array.isArray(row.author)
      ? (row.author[0] ?? null)
      : (row.author as SupportTicketDetail['messages'][number]['author']) ?? null,
  }));

const normalizeTicket = (row: SupportTicketSummary): SupportTicketSummary => ({
  ...row,
  student: Array.isArray(row.student) ? (row.student[0] ?? null) : row.student ?? null,
  assignee: Array.isArray(row.assignee) ? (row.assignee[0] ?? null) : row.assignee ?? null,
});

const getOwnedTicket = async (
  userId: string,
  ticketId: string
): Promise<SupportTicketRecord | null> => {
  const { data, error } = await admin
    .from('support_tickets')
    .select(TICKET_COLUMNS)
    .eq('id', ticketId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as SupportTicketRecord | null) ?? null;
};

const getTicketById = async (
  ticketId: string
): Promise<SupportTicketSummary | null> => {
  const { data, error } = await admin
    .from('support_tickets')
    .select(
      `${TICKET_COLUMNS}, student:profiles!support_tickets_user_id_fkey(full_name,username,email,class_level,avatar_url), assignee:profiles!support_tickets_assigned_to_fkey(full_name,username)`
    )
    .eq('id', ticketId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? normalizeTicket(data as SupportTicketSummary) : null;
};

const loadTicketMessages = async (
  ticketId: string
): Promise<SupportTicketDetail['messages']> => {
  const { data, error } = await admin
    .from('support_ticket_messages')
    .select(
      `${MESSAGE_COLUMNS}, author:profiles!support_ticket_messages_author_id_fkey(id,full_name,username,avatar_url)`
    )
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  return normalizeMessages(data as Array<SupportMessageRecord & { author?: unknown }> | null);
};

const insertMessage = async (input: {
  ticketId: string;
  authorId: string;
  authorRole: 'student' | 'staff';
  body: string;
  attachments?: SupportAttachment[];
}): Promise<SupportMessageRecord> => {
  const { data, error } = await admin
    .from('support_ticket_messages')
    .insert({
      ticket_id: input.ticketId,
      author_id: input.authorId,
      author_role: input.authorRole,
      body: input.body,
      attachments: input.attachments ?? [],
    })
    .select(MESSAGE_COLUMNS)
    .single();

  if (error) throw new Error(error.message);

  return {
    ...(data as SupportMessageRecord),
    attachments: normalizeAttachments((data as SupportMessageRecord).attachments),
  };
};

const updateTicket = async (
  ticketId: string,
  patch: Record<string, unknown>
): Promise<SupportTicketRecord> => {
  const { data, error } = await admin
    .from('support_tickets')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', ticketId)
    .select(TICKET_COLUMNS)
    .single();

  if (error) throw new Error(error.message);
  return data as SupportTicketRecord;
};

const applyStatusTimestamps = (
  status: SupportStatus,
  actorId: string | null
): Record<string, unknown> => {
  if (status === 'resolved') {
    return {
      resolved_at: new Date().toISOString(),
      resolved_by: actorId,
      closed_at: null,
    };
  }

  if (status === 'closed') {
    // Closing a resolved ticket keeps who resolved it; only the closure time
    // is new.
    return { closed_at: new Date().toISOString() };
  }

  return { resolved_at: null, resolved_by: null, closed_at: null };
};

// --- Student -----------------------------------------------------------------

export const createSupportTicket = async (
  userId: string,
  input: CreateSupportTicketInput
): Promise<SupportTicketDetail> => {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();

  const { data: recent, error: duplicateError } = await admin
    .from('support_tickets')
    .select('id')
    .eq('user_id', userId)
    .eq('category', input.category)
    .eq('subject', input.subject)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (duplicateError) throw new Error(duplicateError.message);

  if (recent) {
    throw new SupportConflictError(
      'An identical request was just submitted',
      SUPPORT_ERROR_CODES.DUPLICATE_TICKET,
      { ticket_id: recent.id }
    );
  }

  let attachments: SupportAttachment[] = [];
  if (input.attachments.length > 0) {
    const parsed = parseSupportAttachments(input.attachments);
    attachments = await uploadSupportAttachments(parsed, userId);
  }

  const { data: ticket, error } = await admin
    .from('support_tickets')
    .insert({
      user_id: userId,
      category: input.category,
      subject: input.subject,
      context_question_id: input.contextQuestionId,
      context_exam_id: input.contextExamId,
      context_screen: input.contextScreen,
      last_message_at: new Date().toISOString(),
    })
    .select(TICKET_COLUMNS)
    .single();

  if (error) throw new Error(error.message);

  try {
    await insertMessage({
      ticketId: (ticket as SupportTicketRecord).id,
      authorId: userId,
      authorRole: 'student',
      body: input.description,
      attachments,
    });
  } catch (messageError) {
    // A ticket without its opening report is unusable, so remove the orphan.
    await admin.from('support_tickets').delete().eq('id', (ticket as SupportTicketRecord).id);
    throw messageError;
  }

  const { data: profile } = await admin
    .from('profiles')
    .select('full_name,username')
    .eq('id', userId)
    .maybeSingle();

  const studentName =
    profile?.full_name?.trim() || profile?.username?.trim() || 'A student';

  void notifyStaffOfNewTicket(ticket as SupportTicketRecord, studentName);

  const detail = await getStudentTicketDetail(userId, (ticket as SupportTicketRecord).id);
  return assertTicketExists(detail);
};

export const listStudentTickets = async (
  userId: string,
  query: SupportListQuery
): Promise<SupportTicketListResult> => {
  let request = admin
    .from('support_tickets')
    .select(TICKET_COLUMNS, { count: 'exact' })
    .eq('user_id', userId);

  if (query.status) request = request.eq('status', query.status);
  if (query.category) request = request.eq('category', query.category);

  if (query.search) {
    request = request.or(
      `ticket_ref.ilike.%${query.search}%,subject.ilike.%${query.search}%`
    );
  }

  const { data, count, error } = await request
    .order('updated_at', { ascending: false })
    .range(query.offset, query.offset + query.limit - 1);

  if (error) throw new Error(error.message);

  return {
    items: (data ?? []) as SupportTicketSummary[],
    total: count ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
};

export const getStudentTicketDetail = async (
  userId: string,
  ticketId: string
): Promise<SupportTicketDetail | null> => {
  const ticket = await getOwnedTicket(userId, ticketId);
  if (!ticket) return null;

  return {
    ticket,
    messages: await loadTicketMessages(ticketId),
  };
};

export const addStudentReply = async (
  userId: string,
  ticketId: string,
  body: string
): Promise<SupportTicketDetail> => {
  const ticket = assertTicketExists(await getOwnedTicket(userId, ticketId));

  if (!canStudentReply(ticket.status)) {
    throw new SupportConflictError(
      'This ticket is closed. Open a new request to continue.',
      SUPPORT_ERROR_CODES.TICKET_CLOSED
    );
  }

  const nextStatus = studentReplyStatus(ticket.status);
  const message = await insertMessage({
    ticketId,
    authorId: userId,
    authorRole: 'student',
    body,
  });

  const updated = await updateTicket(ticketId, {
    status: nextStatus,
    last_message_at: new Date().toISOString(),
    ...(ticket.status === 'resolved' ? applyStatusTimestamps('open', null) : {}),
  });

  void notifyStaffOfStudentReply(updated, message.id);
  return {
    ticket: updated,
    messages: await loadTicketMessages(ticketId),
  };
};

export const reopenStudentTicket = async (
  userId: string,
  ticketId: string
): Promise<SupportTicketDetail> => {
  const ticket = assertTicketExists(await getOwnedTicket(userId, ticketId));

  if (!canStudentReopen(ticket.status)) {
    throw new SupportConflictError(
      'Only resolved tickets can be reopened',
      SUPPORT_ERROR_CODES.INVALID_STATUS_TRANSITION
    );
  }

  const updated = await updateTicket(ticketId, {
    status: 'open',
    ...applyStatusTimestamps('open', null),
  });

  return {
    ticket: updated,
    messages: await loadTicketMessages(ticketId),
  };
};

// --- Admin -------------------------------------------------------------------

const findStudentIdsBySearch = async (search: string): Promise<string[]> => {
  const { data, error } = await admin
    .from('profiles')
    .select('id')
    .or(
      `full_name.ilike.%${search}%,username.ilike.%${search}%,email.ilike.%${search}%`
    )
    .limit(25);

  if (error) {
    console.error('[support] student search failed:', error.message);
    return [];
  }

  return ((data ?? []) as Array<{ id: string }>).map((row) => String(row.id));
};

export const listAllTickets = async (
  query: SupportListQuery,
  viewerId: string
): Promise<SupportTicketListResult> => {
  let request = admin
    .from('support_tickets')
    .select(
      `${TICKET_COLUMNS}, student:profiles!support_tickets_user_id_fkey(full_name,username,email,class_level), assignee:profiles!support_tickets_assigned_to_fkey(full_name,username)`,
      { count: 'exact' }
    );

  if (query.status) request = request.eq('status', query.status);
  if (query.category) request = request.eq('category', query.category);
  if (query.priority) request = request.eq('priority', query.priority);
  if (query.dateFrom) request = request.gte('created_at', `${query.dateFrom}T00:00:00.000Z`);
  if (query.dateTo) request = request.lte('created_at', `${query.dateTo}T23:59:59.999Z`);

  if (query.assignedTo === 'unassigned') {
    request = request.is('assigned_to', null);
  } else if (query.assignedTo) {
    request = request.eq('assigned_to', query.assignedTo);
  }

  if (query.search) {
    const studentIds = await findStudentIdsBySearch(query.search);
    const terms = [
      `ticket_ref.ilike.%${query.search}%`,
      `subject.ilike.%${query.search}%`,
    ];
    if (studentIds.length > 0) {
      terms.push(`user_id.in.(${studentIds.join(',')})`);
    }
    request = request.or(terms.join(','));
  }

  const sortColumn = query.sort === 'created' ? 'created_at' : 'updated_at';
  const ascending = query.direction === 'asc';

  const { data, count, error } = await request
    .order(sortColumn, { ascending })
    .range(query.offset, query.offset + query.limit - 1);

  if (error) throw new Error(error.message);

  return {
    items: ((data ?? []) as SupportTicketSummary[]).map(normalizeTicket),
    total: count ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
};

export const getAdminTicketDetail = async (
  ticketId: string
): Promise<SupportTicketDetail | null> => {
  const ticket = await getTicketById(ticketId);
  if (!ticket) return null;

  return {
    ticket,
    messages: await loadTicketMessages(ticketId),
  };
};

export const addAdminReply = async (
  adminId: string,
  ticketId: string,
  body: string
): Promise<SupportTicketDetail> => {
  const ticket = await getTicketById(ticketId);
  const existing = assertTicketExists(ticket);

  const nextStatus = adminReplyStatus(existing.status);
  const message = await insertMessage({
    ticketId,
    authorId: adminId,
    authorRole: 'staff',
    body,
  });

  const updated = await updateTicket(ticketId, {
    status: nextStatus,
    last_message_at: new Date().toISOString(),
    ...(existing.status === 'resolved' || existing.status === 'closed'
      ? applyStatusTimestamps('in_progress', null)
      : {}),
  });

  void notifyStudentOfReply(updated, message.id);

  return {
    ticket: updated,
    messages: await loadTicketMessages(ticketId),
  };
};

export const setTicketStatus = async (
  adminId: string,
  ticketId: string,
  status: SupportStatus
): Promise<SupportTicketRecord> => {
  const ticket = assertTicketExists(await getTicketById(ticketId));

  if (!canTransitionStatus(ticket.status, status)) {
    throw new SupportConflictError(
      `A ${ticket.status.replace('_', ' ')} ticket cannot be moved to ${status.replace('_', ' ')}`,
      SUPPORT_ERROR_CODES.INVALID_STATUS_TRANSITION
    );
  }

  const updated = await updateTicket(ticketId, {
    status,
    ...applyStatusTimestamps(status, adminId),
  });

  void notifyStudentOfStatus(updated, status);

  return updated;
};

export const setTicketPriority = async (
  ticketId: string,
  priority: SupportPriority
): Promise<SupportTicketRecord> => {
  assertTicketExists(await getTicketById(ticketId));
  return updateTicket(ticketId, { priority });
};

const assertAssignableStaff = async (userId: string): Promise<void> => {
  const { data: role, error: roleError } = await admin
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .eq('is_active', true)
    .in('role', ['admin', 'super_admin'])
    .limit(1)
    .maybeSingle();

  if (roleError) throw new Error(roleError.message);

  if (!role) {
    throw new SupportValidationError('Assignee must be an active admin');
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id,account_status,deleted_at')
    .eq('id', userId)
    .maybeSingle();

  if (profileError) throw new Error(profileError.message);

  if (!profile || profile.deleted_at || profile.account_status !== 'active') {
    throw new SupportValidationError('Assignee must be an active admin');
  }
};

export const setTicketAssignment = async (
  ticketId: string,
  assignedTo: string | null
): Promise<SupportTicketRecord> => {
  assertTicketExists(await getTicketById(ticketId));

  if (assignedTo) await assertAssignableStaff(assignedTo);

  return updateTicket(ticketId, { assigned_to: assignedTo });
};

export const getSupportStats = async (): Promise<SupportStats> => {
  const countFor = async (apply: (request: any) => any): Promise<number> => {
    const base = admin
      .from('support_tickets')
      .select('id', { count: 'exact', head: true });
    const { count, error } = await apply(base);
    if (error) throw new Error(error.message);
    return count ?? 0;
  };

  const [total, open, inProgress, awaitingStudent, resolved, closed, unassigned] =
    await Promise.all([
      countFor((request) => request),
      countFor((request) => request.eq('status', 'open')),
      countFor((request) => request.eq('status', 'in_progress')),
      countFor((request) => request.eq('status', 'awaiting_student')),
      countFor((request) => request.eq('status', 'resolved')),
      countFor((request) => request.eq('status', 'closed')),
      countFor((request) =>
        request.is('assigned_to', null).in('status', ACTIVE_SUPPORT_STATUSES)
      ),
    ]);

  return {
    total,
    open,
    in_progress: inProgress,
    awaiting_student: awaitingStudent,
    resolved,
    closed,
    unassigned,
  };
};

export const listSupportAgents = async (): Promise<SupportAgent[]> => {
  const { data: roles, error } = await admin
    .from('user_roles')
    .select('user_id,role')
    .in('role', ['admin', 'super_admin'])
    .eq('is_active', true);

  if (error) throw new Error(error.message);

  const roleByUser = new Map<string, string>();
  for (const row of roles ?? []) {
    const userId = String(row.user_id ?? '');
    if (!userId) continue;
    if (!roleByUser.has(userId) || row.role === 'super_admin') {
      roleByUser.set(userId, row.role);
    }
  }

  const ids = Array.from(roleByUser.keys());
  if (ids.length === 0) return [];

  const { data: profiles, error: profileError } = await admin
    .from('profiles')
    .select('id,full_name,username,account_status,deleted_at')
    .in('id', ids);

  if (profileError) throw new Error(profileError.message);

  const profileRows = (profiles ?? []) as Array<{
    id: string;
    full_name: string | null;
    username: string | null;
    account_status: string | null;
    deleted_at: string | null;
  }>;

  return profileRows
    .filter((profile) => !profile.deleted_at && profile.account_status === 'active')
    .map((profile) => ({
      id: String(profile.id),
      full_name: profile.full_name ?? null,
      username: profile.username ?? null,
      role: roleByUser.get(String(profile.id)) ?? 'admin',
    }))
    .sort((left, right) =>
      (left.full_name ?? left.username ?? '').localeCompare(
        right.full_name ?? right.username ?? ''
      )
    );
};
