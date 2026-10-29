export const NOTICE_PRIORITIES = ['normal', 'important', 'urgent'] as const;

export type NoticePriority = (typeof NOTICE_PRIORITIES)[number];

export type NoticeSubscriptionTarget = 'all' | 'premium' | 'free';

/**
 * Targeting document stored in `notices.target_rules`.
 * Every key is optional; an empty object (or null) targets everyone.
 */
export interface NoticeTargetRules {
  roles?: string[];
  class_levels?: string[];
  subscription?: NoticeSubscriptionTarget;
  languages?: Array<'bn' | 'en'>;
}

export interface NoticeRecord {
  id: string;
  title_bn: string;
  title_en: string | null;
  body_bn: string;
  body_en: string | null;
  image_url: string | null;
  attachment_url: string | null;
  action_link: string | null;
  target_rules: NoticeTargetRules | null;
  priority: NoticePriority;
  is_active: boolean | null;
  created_by: string | null;
  published_at: string | null;
  expires_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface StudentNoticeRecord extends NoticeRecord {
  is_read: boolean;
  is_dismissed: boolean;
  total_count: number;
}

export interface NoticeListOptions {
  limit?: number;
  offset?: number;
  priority?: NoticePriority;
  undismissedOnly?: boolean;
}

export interface NoticeListResult {
  items: StudentNoticeRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface NoticeWritePayload {
  title_bn: string;
  title_en?: string | null;
  body_bn: string;
  body_en?: string | null;
  image_url?: string | null;
  attachment_url?: string | null;
  action_link?: string | null;
  target_rules?: NoticeTargetRules | null;
  priority?: NoticePriority;
  is_active?: boolean;
  published_at?: string | null;
  expires_at?: string | null;
  also_notify?: boolean;
}
