import { supabase } from '../../config/supabase';
import {
  NoticeListOptions,
  NoticeListResult,
  NoticeRecord,
  NoticeTargetRules,
  NoticeWritePayload,
  StudentNoticeRecord,
} from './notices.types';
import { NoticeValidationError, assertNoticeWindow } from './notices.validation';

const NOT_FOUND_MESSAGE = 'Notice not found';

const notFound = (): Error => {
  const error = new Error(NOT_FOUND_MESSAGE);
  error.name = 'NotFoundError';
  (error as Error & { status?: number }).status = 404;
  return error;
};

const toIso = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new NoticeValidationError('Invalid date');
  }
  return new Date(timestamp).toISOString();
};

const normalizePublishedAt = (value: string | null | undefined): string => {
  return toIso(value) ?? new Date().toISOString();
};

const normalizeTargetRules = (
  rules: NoticeTargetRules | null | undefined
): NoticeTargetRules => rules ?? {};

const shouldNotifyNow = (notice: NoticeRecord, alsoNotify: boolean): boolean => {
  if (!alsoNotify || notice.priority !== 'urgent' || notice.is_active !== true) {
    return false;
  }
  return Boolean(notice.published_at && Date.parse(notice.published_at) <= Date.now());
};

/**
 * Optional hook: an admin may also send an in-app notification when publishing
 * an urgent notice. Push is intentionally not used here, and scheduled notices
 * are not notified until a future scheduler exists.
 */
const notifyUrgentNotice = async (notice: NoticeRecord): Promise<void> => {
  try {
    const { data: userIds, error } = await (supabase as any).rpc(
      'get_notice_target_user_ids',
      { p_rules: normalizeTargetRules(notice.target_rules) }
    );

    if (error) {
      console.error('[notices] target lookup failed:', error.message);
      return;
    }

    const recipients = (userIds ?? []) as string[];
    if (recipients.length === 0) return;

    const { notify } = await import('../notifications/notifications.service');
    await notify({
      userIds: recipients,
      type: 'social',
      eventCode: 'notice_published',
      title: {
        bn: notice.title_bn,
        en: notice.title_en?.trim() || notice.title_bn,
      },
      body: {
        bn: notice.body_bn,
        en: notice.body_en?.trim() || notice.body_bn,
      },
      actionLink: `/notices/${notice.id}`,
      priority: 'high',
      channels: ['in_app'],
      dedupeKey: `notice:${notice.id}`,
      metaData: { notice_id: notice.id },
      createdBy: notice.created_by,
    });
  } catch (error) {
    console.error('[notices] urgent notice notification failed:', error);
  }
};

const triggerUrgentNotify = (notice: NoticeRecord, alsoNotify: boolean): void => {
  if (!shouldNotifyNow(notice, alsoNotify)) return;
  void notifyUrgentNotice(notice);
};

// --- Student -----------------------------------------------------------------

export const listNoticesForUser = async (
  userId: string,
  options: NoticeListOptions = {}
): Promise<NoticeListResult> => {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const offset = Math.max(options.offset ?? 0, 0);

  const { data, error } = await (supabase as any).rpc('get_notices_for_user', {
    p_user_id: userId,
    p_limit: limit,
    p_offset: offset,
    p_priority: options.priority ?? null,
    p_undismissed_only: options.undismissedOnly ?? false,
    p_notice_id: null,
  });

  if (error) throw new Error(error.message);

  const items = (data ?? []) as StudentNoticeRecord[];
  return {
    items,
    total: Number(items[0]?.total_count ?? 0),
    limit,
    offset,
  };
};

export const getNoticeForUser = async (
  userId: string,
  noticeId: string
): Promise<StudentNoticeRecord | null> => {
  const { data, error } = await (supabase as any).rpc('get_notices_for_user', {
    p_user_id: userId,
    p_limit: 1,
    p_offset: 0,
    p_priority: null,
    p_undismissed_only: false,
    p_notice_id: noticeId,
  });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as StudentNoticeRecord[];
  return rows[0] ?? null;
};

export const getUrgentNoticeForUser = async (
  userId: string
): Promise<StudentNoticeRecord | null> => {
  const result = await listNoticesForUser(userId, {
    limit: 1,
    priority: 'urgent',
    undismissedOnly: true,
  });
  return result.items[0] ?? null;
};

export const getUnreadNoticeCount = async (userId: string): Promise<number> => {
  const { data, error } = await (supabase as any).rpc(
    'get_unread_notice_count_for_user',
    { p_user_id: userId }
  );

  if (error) throw new Error(error.message);
  return Number(data ?? 0);
};

export const markNoticeRead = async (userId: string, noticeId: string): Promise<void> => {
  const notice = await getNoticeForUser(userId, noticeId);
  if (!notice) throw notFound();

  const { error } = await (supabase as any).from('notice_reads').upsert(
    {
      user_id: userId,
      notice_id: noticeId,
      read_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,notice_id' }
  );

  if (error) throw new Error(error.message);
};

export const dismissNotice = async (userId: string, noticeId: string): Promise<void> => {
  const notice = await getNoticeForUser(userId, noticeId);
  if (!notice) throw notFound();

  const now = new Date().toISOString();
  const { error } = await (supabase as any).from('notice_reads').upsert(
    {
      user_id: userId,
      notice_id: noticeId,
      read_at: now,
      dismissed_at: now,
    },
    { onConflict: 'user_id,notice_id' }
  );

  if (error) throw new Error(error.message);
};

// --- Admin -------------------------------------------------------------------

export const listAllNotices = async (): Promise<NoticeRecord[]> => {
  const { data, error } = await (supabase as any)
    .from('notices')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as NoticeRecord[];
};

export const getNoticeById = async (noticeId: string): Promise<NoticeRecord | null> => {
  const { data, error } = await (supabase as any)
    .from('notices')
    .select('*')
    .eq('id', noticeId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as NoticeRecord | null) ?? null;
};

export const createNotice = async (
  payload: NoticeWritePayload,
  adminId: string
): Promise<NoticeRecord> => {
  const publishedAt = normalizePublishedAt(payload.published_at);
  const expiresAt = toIso(payload.expires_at);
  assertNoticeWindow(publishedAt, expiresAt);

  const { data, error } = await (supabase as any)
    .from('notices')
    .insert({
      title_bn: payload.title_bn,
      title_en: payload.title_en ?? null,
      body_bn: payload.body_bn,
      body_en: payload.body_en ?? null,
      image_url: payload.image_url ?? null,
      attachment_url: payload.attachment_url ?? null,
      action_link: payload.action_link ?? null,
      target_rules: normalizeTargetRules(payload.target_rules),
      priority: payload.priority ?? 'normal',
      is_active: payload.is_active ?? true,
      published_at: publishedAt,
      expires_at: expiresAt,
      created_by: adminId,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  const notice = data as NoticeRecord;
  triggerUrgentNotify(notice, payload.also_notify === true);
  return notice;
};

export const updateNotice = async (
  noticeId: string,
  payload: NoticeWritePayload
): Promise<NoticeRecord> => {
  const existing = await getNoticeById(noticeId);
  if (!existing) throw notFound();

  const nextPublishedAt =
    payload.published_at !== undefined
      ? normalizePublishedAt(payload.published_at)
      : existing.published_at;
  const nextExpiresAt =
    payload.expires_at !== undefined ? toIso(payload.expires_at) : existing.expires_at;

  assertNoticeWindow(nextPublishedAt, nextExpiresAt);

  const patch: Record<string, unknown> = {};
  const assign = <K extends keyof NoticeWritePayload>(key: K) => {
    if (payload[key] !== undefined) patch[key] = payload[key];
  };

  assign('title_bn');
  assign('title_en');
  assign('body_bn');
  assign('body_en');
  assign('image_url');
  assign('attachment_url');
  assign('action_link');
  assign('priority');
  assign('is_active');
  if (payload.target_rules !== undefined) {
    patch.target_rules = normalizeTargetRules(payload.target_rules);
  }

  if (payload.published_at !== undefined) patch.published_at = nextPublishedAt;
  if (payload.expires_at !== undefined) patch.expires_at = nextExpiresAt;

  if (Object.keys(patch).length === 0) {
    throw new NoticeValidationError('No notice fields supplied');
  }

  const { data, error } = await (supabase as any)
    .from('notices')
    .update(patch)
    .eq('id', noticeId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  const notice = data as NoticeRecord;
  triggerUrgentNotify(notice, payload.also_notify === true);
  return notice;
};

export const publishNotice = async (
  noticeId: string,
  publishedAtInput: string | null | undefined,
  alsoNotify: boolean
): Promise<NoticeRecord> => {
  const existing = await getNoticeById(noticeId);
  if (!existing) throw notFound();

  const publishedAt = normalizePublishedAt(publishedAtInput);
  assertNoticeWindow(publishedAt, existing.expires_at);

  const { data, error } = await (supabase as any)
    .from('notices')
    .update({ is_active: true, published_at: publishedAt })
    .eq('id', noticeId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  const notice = data as NoticeRecord;
  triggerUrgentNotify(notice, alsoNotify);
  return notice;
};

export const expireNotice = async (noticeId: string): Promise<NoticeRecord> => {
  const existing = await getNoticeById(noticeId);
  if (!existing) throw notFound();

  const { data, error } = await (supabase as any)
    .from('notices')
    .update({ expires_at: new Date().toISOString() })
    .eq('id', noticeId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data as NoticeRecord;
};

export const setNoticeActive = async (
  noticeId: string,
  isActive: boolean
): Promise<NoticeRecord> => {
  const { data, error } = await (supabase as any)
    .from('notices')
    .update({ is_active: isActive })
    .eq('id', noticeId)
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw notFound();
  return data as NoticeRecord;
};

export const deleteNotice = async (noticeId: string): Promise<void> => {
  const existing = await getNoticeById(noticeId);
  if (!existing) throw notFound();

  const { error } = await (supabase as any).from('notices').delete().eq('id', noticeId);
  if (error) throw new Error(error.message);
};
