import { supabase } from '../../config/supabase';

type AnyObject = Record<string, any>;

type SubjectLabel = {
  id: string;
  name_en: string | null;
  name_bn: string | null;
};

const normalizeId = (value: unknown): string => String(value ?? '').trim();

const asArray = (value: unknown): AnyObject[] =>
  Array.isArray(value) ? (value as AnyObject[]) : [];

const asRecord = (value: unknown): AnyObject | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyObject)
    : null;

const parseJsonValue = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const isMissingRelationError = (error: unknown): boolean => {
  const candidate = (error ?? {}) as AnyObject;
  return (
    candidate.code === '42P01' ||
    candidate.code === 'PGRST205' ||
    /relation .* does not exist|could not find the table/i.test(
      String(candidate.message ?? '')
    )
  );
};

const loadHistorySubjects = async (
  historyIds: string[]
): Promise<Map<string, SubjectLabel[]>> => {
  const result = new Map<string, SubjectLabel[]>();
  if (historyIds.length === 0) return result;

  const { data, error } = await supabase
    .from('exam_history_details')
    .select('exam_history_id, question_id, questions ( subject_id )')
    .in('exam_history_id', historyIds);

  if (error) return result;

  const subjectIdsByHistory = new Map<string, Set<string>>();
  const subjectIds = new Set<string>();

  for (const row of asArray(data)) {
    const historyId = normalizeId(row.exam_history_id);
    const question = Array.isArray(row.questions) ? row.questions[0] : row.questions;
    const subjectId = normalizeId(question?.subject_id);
    if (!historyId || !subjectId) continue;

    const current = subjectIdsByHistory.get(historyId) ?? new Set<string>();
    current.add(subjectId);
    subjectIdsByHistory.set(historyId, current);
    subjectIds.add(subjectId);
  }

  if (subjectIds.size === 0) return result;

  const { data: subjects, error: subjectsError } = await supabase
    .from('subjects')
    .select('id, name_en, name_bn')
    .in('id', Array.from(subjectIds));

  if (subjectsError) return result;

  const subjectsById = new Map<string, SubjectLabel>();
  for (const subject of asArray(subjects)) {
    const id = normalizeId(subject.id);
    if (!id) continue;
    subjectsById.set(id, {
      id,
      name_en: subject.name_en ?? null,
      name_bn: subject.name_bn ?? null,
    });
  }

  subjectIdsByHistory.forEach((ids, historyId) => {
    result.set(
      historyId,
      Array.from(ids)
        .map((id) => subjectsById.get(id))
        .filter((subject): subject is SubjectLabel => Boolean(subject))
    );
  });

  return result;
};

const historyTimestamp = (row: AnyObject): number => {
  const raw = row.submitted_at || row.created_at || row.taken_at || '';
  const parsed = Date.parse(String(raw));
  return Number.isNaN(parsed) ? 0 : parsed;
};

export const getUserExamHistory = async (userId: string) => {
  // The history list only needs attempt summaries. details_json is intentionally
  // omitted: it can contain answer-key snapshots that must go through the
  // owner-scoped, publish-time-gated result review endpoint instead.
  const { data, error } = await supabase
    .from('exam_history')
    .select(
      'id, exam_id, score, total_marks, correct_count, wrong_count, skipped_count, time_taken, submitted_at, created_at, status, practice_mode, source_history_id'
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const rows = asArray(data);

  // Resolve presentation metadata in batched backend queries. The mobile client
  // used to issue extra Supabase requests after every history load.
  const examIds = [
    ...new Set(
      rows
        .map((row) => (row.exam_id ? normalizeId(row.exam_id) : null))
        .filter((id): id is string => Boolean(id))
    ),
  ];

  const historyIds = rows
    .map((row) => normalizeId(row.id))
    .filter(Boolean);

  const [examMetadata, subjectsByHistory, mistakeCounts] = await Promise.all([
    (async () => {
      const metadata = new Map<
        string,
        {
          title: string | null;
          subjectNameEn: string | null;
          subjectNameBn: string | null;
          subject: SubjectLabel | null;
        }
      >();

      if (examIds.length === 0) return metadata;

      const { data: exams, error: examsError } = await supabase
        .from('exam_papers')
        .select('id, title, subject_id, subjects ( name_en, name_bn )')
        .in('id', examIds);

      if (examsError) return metadata;

      for (const exam of asArray(exams)) {
        const subject = Array.isArray(exam.subjects) ? exam.subjects[0] : exam.subjects;
        const subjectId = normalizeId(subject?.id ?? exam.subject_id);

        metadata.set(normalizeId(exam.id), {
          title: exam.title ?? null,
          subjectNameEn: subject?.name_en ?? null,
          subjectNameBn: subject?.name_bn ?? null,
          subject: subjectId
            ? {
                id: subjectId,
                name_en: subject?.name_en ?? null,
                name_bn: subject?.name_bn ?? null,
              }
            : null,
        });
      }

      return metadata;
    })(),
    loadHistorySubjects(historyIds),
    loadMistakeCountsByHistory(userId),
  ]);

  // A stable, human-meaningful attempt number: oldest attempt is #1.
  const chronological = [...rows].sort((a, b) => {
    const diff = historyTimestamp(a) - historyTimestamp(b);
    return diff !== 0 ? diff : normalizeId(a.id).localeCompare(normalizeId(b.id));
  });
  const sequenceById = new Map<string, number>();
  chronological.forEach((row, index) => {
    sequenceById.set(normalizeId(row.id), index + 1);
  });

  return rows.map((row) => {
    const id = normalizeId(row.id);
    const correct = Math.max(0, Number(row.correct_count ?? 0));
    const wrong = Math.max(0, Number(row.wrong_count ?? 0));
    const skipped = Math.max(0, Number(row.skipped_count ?? 0));
    const metadata = row.exam_id ? examMetadata.get(normalizeId(row.exam_id)) : undefined;
    const derivedSubjects = subjectsByHistory.get(id) ?? [];
    const subjects = metadata?.subject ? [metadata.subject] : derivedSubjects;
    const primarySubject = metadata?.subject ?? derivedSubjects[0] ?? null;
    const countedQuestions = correct + wrong + skipped;
    // Same definition as the Mistakes tab: wrong or skipped, latest response
    // per question, minus dismissals. The stored counters are only a fallback
    // when the shared SQL definition cannot be read at all.
    const canonicalMistakes = mistakeCounts
      ? mistakeCounts.get(id) ?? 0
      : wrong + skipped;

    return {
      ...row,
      exam_title: metadata?.title ?? null,
      subject_name_en: metadata?.subjectNameEn ?? primarySubject?.name_en ?? null,
      subject_name_bn: metadata?.subjectNameBn ?? primarySubject?.name_bn ?? null,
      subjects,
      exam_sequence: sequenceById.get(id) ?? null,
      question_count:
        countedQuestions > 0
          ? countedQuestions
          : Math.max(0, Number(row.total_marks ?? 0)),
      completion_status:
        row.status ?? (row.submitted_at ? 'completed' : 'in_progress'),
      retake_available_count: correct + wrong + skipped,
      wrong_available_count: canonicalMistakes,
    };
  });
};

const REVIEW_QUESTION_SELECT =
  'id, subject_id, type, body, options, explanation, media_id, media_library!questions_media_id_fkey(file_url)';

/**
 * Questions that belong to a live, non-practice exam paper must not expose an
 * answer key through a secondary list. The review endpoint applies the same
 * rule; this helper keeps bookmarks and mistakes from becoming a bypass.
 */
const loadAnswerRestrictedQuestionIds = async (
  questionIds: string[]
): Promise<Set<string>> => {
  if (questionIds.length === 0) return new Set();

  const { data, error } = await supabase
    .from('exam_paper_questions')
    .select(
      'question_id, exam_papers!inner(exam_type, end_time, result_publish_time)'
    )
    .in('question_id', questionIds);

  // Fail closed: if the restriction check cannot run, do not reveal keys.
  if (error) return new Set(questionIds);

  const now = Date.now();
  const restricted = new Set<string>();

  for (const row of asArray(data)) {
    const paper = Array.isArray(row.exam_papers)
      ? row.exam_papers[0]
      : row.exam_papers;
    if (!paper || paper.exam_type === 'practice') continue;

    const endTime = paper.end_time ? Date.parse(String(paper.end_time)) : NaN;
    const publishTime = paper.result_publish_time
      ? Date.parse(String(paper.result_publish_time))
      : NaN;

    const isLive =
      Number.isNaN(endTime) ||
      endTime > now ||
      (!Number.isNaN(publishTime) && publishTime > now);

    if (isLive) restricted.add(normalizeId(row.question_id));
  }

  return restricted;
};

const isOptionCorrect = (option: AnyObject): boolean =>
  option?.isCorrect === true ||
  option?.is_correct === true ||
  option?.correct === true ||
  String(option?.isCorrect).toLowerCase() === 'true' ||
  String(option?.is_correct).toLowerCase() === 'true';

const sanitizeReviewQuestion = (
  question: AnyObject,
  includeCorrectAnswers: boolean
): AnyObject => {
  const options = asArray(question.options).map((option) => {
    const sanitized: AnyObject = {
      id: option?.id ?? null,
      text_bn: option?.text_bn ?? null,
      text_en: option?.text_en ?? null,
      image_url: option?.image_url ?? null,
    };

    if (includeCorrectAnswers) sanitized.isCorrect = isOptionCorrect(option);
    return sanitized;
  });

  const media = Array.isArray(question.media_library)
    ? question.media_library[0]
    : question.media_library;
  const body = parseJsonValue(question.body);
  const bodyRecord = asRecord(body);

  return {
    id: normalizeId(question.id),
    subject_id: question.subject_id ?? null,
    type: question.type ?? null,
    body,
    options,
    explanation: includeCorrectAnswers
      ? parseJsonValue(question.explanation)
      : null,
    image_url: bodyRecord?.image_url ?? media?.file_url ?? null,
  };
};

const loadReviewQuestions = async (
  questionIds: string[]
): Promise<Map<string, AnyObject>> => {
  const result = new Map<string, AnyObject>();
  if (questionIds.length === 0) return result;

  const [{ data, error }, restrictedIds] = await Promise.all([
    supabase
      .from('questions')
      .select(REVIEW_QUESTION_SELECT)
      .in('id', questionIds),
    loadAnswerRestrictedQuestionIds(questionIds),
  ]);

  if (error) throw error;

  for (const question of asArray(data)) {
    const id = normalizeId(question.id);
    if (!id) continue;
    result.set(id, sanitizeReviewQuestion(question, !restrictedIds.has(id)));
  }

  return result;
};

const DISMISSALS_SETTINGS_KEY = 'mistake_dismissals';

/**
 * Fallback used only when the additive dismissal table is not deployed yet.
 * The single mistake definition lives in SQL (public.user_mistake_questions);
 * this keeps "delete mistake" working on a database that has not applied the
 * dismissals migration.
 */
const saveDismissalToSettings = async (
  userId: string,
  questionId: string,
  createdAt: string
): Promise<void> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('settings')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;

  const settings = asRecord(data?.settings) ?? {};
  const dismissals = asRecord(settings[DISMISSALS_SETTINGS_KEY]) ?? {};
  const nextSettings = {
    ...settings,
    [DISMISSALS_SETTINGS_KEY]: {
      ...dismissals,
      [questionId]: createdAt,
    },
  };

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ settings: nextSettings })
    .eq('id', userId);

  if (updateError) throw updateError;
};

type MistakeRpcRow = {
  question_id: string | null;
  detail_id: string | null;
  exam_history_id: string | null;
  exam_id: string | null;
  status: string | null;
  selected_option: string | null;
  occurred_at: string | null;
};

const normalizeMistakeStatus = (
  value: unknown,
  selectedOption: unknown
): 'wrong' | 'skipped' => {
  const status = String(value ?? '').trim().toLowerCase();
  if (status === 'wrong' || status === 'skipped') return status;

  // Defensive: an unlabelled row is a wrong answer when an option was chosen.
  return normalizeId(selectedOption) ? 'wrong' : 'skipped';
};

const toIsoOrNull = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

/**
 * The one mistake definition: wrong OR skipped, latest response per question,
 * minus dismissals newer than that response. The SQL function is the single
 * source of truth for the Mistakes tab, per-attempt practice counts, per-attempt
 * practice and the cross-exam mistake pool.
 */
const loadMistakeRows = async (userId: string): Promise<MistakeRpcRow[]> => {
  const { data, error } = await supabase.rpc('user_mistake_questions', {
    p_user_id: userId,
  });

  if (error) throw error;

  return asArray(data) as MistakeRpcRow[];
};

/**
 * Per-attempt mistake counts from the same definition. A failure here must not
 * hide the history list, so it degrades to the stored attempt counters.
 */
const loadMistakeCountsByHistory = async (
  userId: string
): Promise<Map<string, number> | null> => {
  const { data, error } = await supabase.rpc('get_user_mistake_counts', {
    p_user_id: userId,
  });

  if (error) {
    console.error('[history] mistake counts unavailable, using attempt counters');
    return null;
  }

  const counts = new Map<string, number>();
  for (const row of asArray(data)) {
    const historyId = normalizeId(row.exam_history_id);
    if (!historyId) continue;
    counts.set(historyId, Math.max(0, Number(row.mistake_count ?? 0)));
  }

  return counts;
};

export const getUserMistakes = async (userId: string) => {
  const rows = await loadMistakeRows(userId);

  const questionIds = Array.from(
    new Set(rows.map((row) => normalizeId(row.question_id)).filter(Boolean))
  );
  const questions = await loadReviewQuestions(questionIds);

  return rows
    .map((row) => {
      const questionId = normalizeId(row.question_id);
      if (!questionId) return null;

      return {
        // Question-level collection: repeated wrong attempts do not create
        // duplicate cards, while a later correct answer removes the card.
        id: questionId,
        detail_id: normalizeId(row.detail_id) || null,
        question_id: questionId,
        status: normalizeMistakeStatus(row.status, row.selected_option),
        selected_option: row.selected_option ?? null,
        occurred_at: toIsoOrNull(row.occurred_at),
        questions: questions.get(questionId) ?? null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
};


export const getUserBookmarks = async (userId: string) => {
  const { data, error } = await supabase
    .from('bookmarks')
    .select('id, note, question_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const rows = asArray(data);
  const questionIds = Array.from(
    new Set(
      rows
        .map((row) => normalizeId(row.question_id))
        .filter(Boolean)
    )
  );
  const questions = await loadReviewQuestions(questionIds);

  // Do not drop a bookmark when its question row is missing; the UI renders an
  // explicit "question not available" state instead of silently losing it.
  return rows.map((row) => {
    const questionId = normalizeId(row.question_id);
    return {
      id: normalizeId(row.id),
      note: row.note ?? null,
      question_id: questionId,
      created_at: row.created_at ?? null,
      questions: questions.get(questionId) ?? null,
    };
  });
};

const resolveMistakeQuestionId = async (
  mistakeId: string,
  userId: string
): Promise<string> => {
  const { data, error } = await supabase
    .from('wrong_answers')
    .select('id, question_id')
    .eq('user_id', userId)
    .or(`id.eq.${mistakeId},question_id.eq.${mistakeId}`)
    .limit(1)
    .maybeSingle();

  if (error) return mistakeId;
  return normalizeId(data?.question_id) || mistakeId;
};

export const deleteMistakeRecord = async (mistakeId: string, userId: string) => {
  const normalizedId = normalizeId(mistakeId);
  if (!normalizedId) return true;

  const questionId = await resolveMistakeQuestionId(normalizedId, userId);

  // Clear a legacy row as well as any id-based match.
  const { error } = await supabase
    .from('wrong_answers')
    .delete()
    .eq('user_id', userId)
    .or(`id.eq.${normalizedId},question_id.eq.${questionId}`);

  if (error && !isMissingRelationError(error)) throw error;

  const createdAt = new Date().toISOString();
  const { error: dismissError } = await supabase
    .from('mistake_dismissals')
    .upsert(
      {
        user_id: userId,
        question_id: questionId,
        created_at: createdAt,
      },
      { onConflict: 'user_id,question_id' }
    );

  if (dismissError) {
    if (isMissingRelationError(dismissError)) {
      await saveDismissalToSettings(userId, questionId, createdAt);
    } else {
      throw dismissError;
    }
  }

  return true;
};

export const deleteBookmarkRecord = async (bookmarkId: string, userId: string) => {
  const { error } = await supabase
    .from('bookmarks')
    .delete()
    .eq('id', bookmarkId)
    .eq('user_id', userId); // Ensure the user owns the record

  if (error) throw error;
  return true;
};
