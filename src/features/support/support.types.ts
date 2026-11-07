export const SUPPORT_CATEGORIES = [
  'general',
  'bug',
  'question',
  'exam',
  'account',
  'payment',
  'feature',
  'other',
] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_STATUSES = [
  'open',
  'in_progress',
  'awaiting_student',
  'resolved',
  'closed',
] as const;

export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const SUPPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export type SupportAuthorRole = 'student' | 'staff';

export interface SupportAttachment {
  url: string;
  name: string;
  mime_type: string;
  size: number;
}

export interface SupportTicketRecord {
  id: string;
  ticket_ref: string;
  user_id: string;
  category: SupportCategory;
  subject: string;
  status: SupportStatus;
  priority: SupportPriority;
  assigned_to: string | null;
  context_question_id: string | null;
  context_exam_id: string | null;
  context_screen: string | null;
  last_message_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupportMessageRecord {
  id: string;
  ticket_id: string;
  author_id: string;
  author_role: SupportAuthorRole;
  body: string;
  attachments: SupportAttachment[];
  created_at: string;
}

export interface SupportStudentSummary {
  full_name: string | null;
  username: string | null;
  email: string | null;
  class_level?: string | null;
  avatar_url?: string | null;
}

export interface SupportTicketSummary extends SupportTicketRecord {
  student?: SupportStudentSummary | null;
  assignee?: { full_name: string | null; username: string | null } | null;
}

export interface SupportTicketDetail {
  ticket: SupportTicketSummary;
  messages: Array<
    SupportMessageRecord & {
      author?: { id: string; full_name: string | null; username: string | null; avatar_url: string | null } | null;
    }
  >;
}

export interface SupportTicketListResult {
  items: SupportTicketSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface SupportStats {
  total: number;
  open: number;
  in_progress: number;
  awaiting_student: number;
  resolved: number;
  closed: number;
  unassigned: number;
}

export interface SupportAgent {
  id: string;
  full_name: string | null;
  username: string | null;
  role: string;
}
