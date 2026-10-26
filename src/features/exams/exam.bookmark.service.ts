import { supabase } from '../../config/supabase';
import { isUuid } from '../../lib/utils/search';

type AnyObject = Record<string, any>;

export class BookmarkError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'BookmarkError';
    this.status = status;
  }
}

const normalizeId = (value: unknown): string => String(value ?? '').trim();

const logDatabaseError = (operation: string, error: AnyObject): void => {
  console.error('[exam-bookmark]', {
    operation,
    code: error?.code ?? null,
    message: error?.message ?? 'unknown database error',
  });
};

const requireUserId = (userId: string): string => {
  const normalized = normalizeId(userId);

  if (!normalized) {
    throw new BookmarkError('Unauthorized', 401);
  }

  return normalized;
};

const requireQuestionId = (value: unknown): string => {
  const questionId = normalizeId(value);

  if (!isUuid(questionId)) {
    throw new BookmarkError('A valid question id is required', 400);
  }

  return questionId;
};

const requireDesiredState = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'boolean') {
    throw new BookmarkError('Bookmark state must be a boolean', 400);
  }

  return value;
};

const assertQuestionExists = async (questionId: string): Promise<void> => {
  const { data, error } = await supabase
    .from('questions')
    .select('id')
    .eq('id', questionId)
    .maybeSingle();

  if (error) {
    logDatabaseError('question_lookup', error);
    throw new BookmarkError('Bookmark could not be saved', 500);
  }

  if (!data) {
    throw new BookmarkError('Question not found', 404);
  }
};

const isBookmarked = async (
  userId: string,
  questionId: string
): Promise<boolean> => {
  const { data, error } = await supabase
    .from('bookmarks')
    .select('id')
    .eq('user_id', userId)
    .eq('question_id', questionId)
    .maybeSingle();

  if (error) {
    logDatabaseError('state_lookup', error);
    throw new BookmarkError('Bookmark state could not be loaded', 500);
  }

  return Boolean(data);
};

const addBookmark = async (
  userId: string,
  questionId: string
): Promise<void> => {
  const { error } = await supabase
    .from('bookmarks')
    .upsert(
      { user_id: userId, question_id: questionId },
      { onConflict: 'user_id,question_id', ignoreDuplicates: true }
    );

  if (error) {
    logDatabaseError('insert', error);
    throw new BookmarkError('Bookmark could not be saved', 500);
  }
};

const removeBookmark = async (
  userId: string,
  questionId: string
): Promise<void> => {
  const { error } = await supabase
    .from('bookmarks')
    .delete()
    .eq('user_id', userId)
    .eq('question_id', questionId);

  if (error) {
    logDatabaseError('delete', error);
    throw new BookmarkError('Bookmark could not be removed', 500);
  }
};

/**
 * Sets or toggles a bookmark for the authenticated user.
 *
 * `bookmarked` is optional for compatibility with the original client, which
 * only sent the question id. When supplied, the operation is idempotent; the
 * database unique constraint on (user_id, question_id) is used with an upsert
 * so repeated or rapid requests cannot create duplicate rows.
 */
export const setBookmark = async (
  userId: string,
  rawQuestionId: unknown,
  rawBookmarked?: unknown
): Promise<{ questionId: string; bookmarked: boolean }> => {
  const authenticatedUserId = requireUserId(userId);
  const questionId = requireQuestionId(rawQuestionId);
  const desiredState = requireDesiredState(rawBookmarked);

  await assertQuestionExists(questionId);

  const bookmarked =
    desiredState === undefined
      ? !(await isBookmarked(authenticatedUserId, questionId))
      : desiredState;

  if (bookmarked) {
    await addBookmark(authenticatedUserId, questionId);
  } else {
    await removeBookmark(authenticatedUserId, questionId);
  }

  return { questionId, bookmarked };
};

/**
 * Returns the question ids bookmarked by the authenticated user, optionally
 * limited to a client-provided set. Ownership always comes from the verified
 * session, never from the request body.
 */
export const getBookmarkQuestionIds = async (
  userId: string,
  rawQuestionIds?: unknown
): Promise<string[]> => {
  const authenticatedUserId = requireUserId(userId);

  let questionIds: string[] = [];

  if (rawQuestionIds !== undefined) {
    const values = Array.isArray(rawQuestionIds)
      ? rawQuestionIds
      : String(rawQuestionIds).split(',');

    questionIds = Array.from(
      new Set(values.map((value) => normalizeId(value)).filter(Boolean))
    );

    if (questionIds.some((questionId) => !isUuid(questionId))) {
      throw new BookmarkError('Question ids must be valid', 400);
    }
  }

  let query = supabase
    .from('bookmarks')
    .select('question_id')
    .eq('user_id', authenticatedUserId);

  if (questionIds.length > 0) {
    query = query.in('question_id', questionIds);
  }

  const { data, error } = await query;

  if (error) {
    logDatabaseError('list', error);
    throw new BookmarkError('Bookmarks could not be loaded', 500);
  }

  return Array.from(
    new Set(
      (data ?? [])
        .map((row: AnyObject) => normalizeId(row.question_id))
        .filter(Boolean)
    )
  );
};
