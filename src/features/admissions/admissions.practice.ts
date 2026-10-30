/**
 * Pure helpers for the student admission experience.
 *
 * Phase 1 stores unit identity in `admission_units` / `exam_papers.admission_unit_id`
 * and Phase 2 writes the canonical `meta_data.exam_mode` / `meta_data.admission_session`
 * keys. Nothing here touches the database: the rules that decide which papers are
 * past exams, how sessions group, and which questions make up a subject practice
 * set are expressed as functions so they can be tested directly.
 */

export const ADMISSION_PRACTICE_MAX_QUESTIONS = 50;
export const ADMISSION_PRACTICE_DEFAULT_QUESTIONS = 20;

export type AdmissionPaperMode = 'past_exam' | 'subject_practice' | 'model_test';

export interface AdmissionPaperRow {
  id: string;
  title: string;
  title_en?: string | null;
  subject_id?: string | null;
  meta_data?: unknown;
  duration_min?: number | null;
  total_marks?: number | null;
  is_premium?: boolean | null;
  start_time?: string | null;
  end_time?: string | null;
  default_negative_marks?: number | null;
  created_at?: string | null;
}

export interface AdmissionQuestionRow {
  id: string;
  subject_id: string | null;
  chapter_id: string | null;
}

export interface AdmissionSubjectPoolEntry {
  subjectId: string;
  questionIds: string[];
  byChapter: Map<string, string[]>;
}

export interface AdmissionSessionGroup<T extends AdmissionPaperRow = AdmissionPaperRow> {
  session: string | null;
  papers: T[];
}

type AnyObject = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const metaOf = (paper: Pick<AdmissionPaperRow, 'meta_data'>): AnyObject | null =>
  isRecord(paper.meta_data) ? paper.meta_data : null;

const cleanString = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
};

const firstText = (source: AnyObject | null, keys: string[]): string | null => {
  if (!source) return null;

  for (const key of keys) {
    const value = cleanString(source[key]);
    if (value) return value;
  }

  return null;
};

const parseNumber = (value: unknown): number | null => {
  const raw = cleanString(value);
  if (!raw) return null;

  const parsed = Number(raw.replace(/[^0-9.-]/g, ''));

  return Number.isFinite(parsed) ? parsed : null;
};

const firstNumber = (source: AnyObject | null, keys: string[]): number | null => {
  if (!source) return null;

  for (const key of keys) {
    const value = parseNumber(source[key]);
    if (value !== null) return value;
  }

  return null;
};

/** Canonical `admission_session`, or the legacy explicit year key. */
const resolveDeclaredSession = (paper: Pick<AdmissionPaperRow, 'meta_data'>): string | null => {
  const meta = metaOf(paper);
  const declared = firstText(meta, ['admission_session', 'session', 'exam_session']);
  if (declared) return declared;

  const year = firstNumber(meta, ['year', 'exam_year', 'admission_year', 'session_year']);
  if (year !== null && year >= 1950 && year <= 2100) return String(Math.trunc(year));

  return null;
};

/** Session label for a historical paper: declared session, else the title year. */
export const resolvePaperSession = (
  paper: Pick<AdmissionPaperRow, 'title' | 'meta_data'>
): string | null => {
  const declared = resolveDeclaredSession(paper);
  if (declared) return declared;

  const fromTitle = cleanString(paper.title)?.match(/(19|20)\d{2}/);

  return fromTitle ? fromTitle[0] : null;
};

export const resolveModelTestNo = (
  paper: Pick<AdmissionPaperRow, 'meta_data'>
): number | null => {
  const meta = metaOf(paper);
  const declared = firstNumber(meta, ['model_test_no', 'model_test_number', 'model_no', 'test_no']);

  return declared !== null ? Math.trunc(declared) : null;
};

/**
 * Paper mode with the same precedence the admin authoring API writes:
 * canonical `exam_mode` first, then legacy metadata, then the title.
 */
export const resolvePaperMode = (
  paper: Pick<AdmissionPaperRow, 'title' | 'meta_data'>
): AdmissionPaperMode | null => {
  const meta = metaOf(paper);
  const declared = cleanString(meta?.exam_mode)?.toLowerCase().replace(/-/g, '_');

  if (declared === 'past_exam' || declared === 'past_exams') return 'past_exam';
  if (declared === 'subject_practice') return 'subject_practice';
  if (declared === 'model_test') return 'model_test';

  // Legacy rows carry no exam_mode. A stated session means a past paper; a
  // model number means a model test. The title is only consulted afterwards so
  // "Model Test 2024" is not mistaken for a historical paper.
  if (resolveDeclaredSession(paper)) return 'past_exam';
  if (resolveModelTestNo(paper) !== null) return 'model_test';

  const title = cleanString(paper.title) ?? '';
  if (/(model|মডেল)/i.test(title)) return 'model_test';
  if (/(19|20)\d{2}/.test(title)) return 'past_exam';

  return null;
};

const sessionYear = (session: string | null): number => {
  const match = session?.match(/(19|20)\d{2}/);

  return match ? Number(match[0]) : 0;
};

/**
 * Historical papers grouped by session, newest session first. Papers without a
 * usable session are kept in a trailing `null` group instead of being invented
 * into a session the content did not declare.
 */
export const groupPastExams = <T extends AdmissionPaperRow>(
  papers: T[]
): AdmissionSessionGroup<T>[] => {
  const groups = new Map<string | null, T[]>();

  for (const paper of papers) {
    if (resolvePaperMode(paper) !== 'past_exam') continue;

    const session = resolvePaperSession(paper);
    const list = groups.get(session) ?? [];
    list.push(paper);
    groups.set(session, list);
  }

  return [...groups.entries()]
    .map(([session, list]) => ({
      session,
      papers: list
        .slice()
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))),
    }))
    .sort((a, b) => {
      if (a.session === null && b.session !== null) return 1;
      if (b.session === null && a.session !== null) return -1;

      return (
        sessionYear(b.session) - sessionYear(a.session) ||
        String(a.session ?? '').localeCompare(String(b.session ?? ''))
      );
    });
};

/** Model tests ordered by their declared model number, then newest first. */
export const selectModelTests = <T extends AdmissionPaperRow>(papers: T[]): T[] =>
  papers
    .filter((paper) => resolvePaperMode(paper) === 'model_test')
    .slice()
    .sort((a, b) => {
      const aNo = resolveModelTestNo(a) ?? Number.POSITIVE_INFINITY;
      const bNo = resolveModelTestNo(b) ?? Number.POSITIVE_INFINITY;
      if (aNo !== bNo) return aNo - bNo;

      return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
    });

/** Questions grouped by subject (and chapter) so practice never mixes subjects. */
export const buildUnitSubjectPool = (
  questions: AdmissionQuestionRow[]
): Map<string, AdmissionSubjectPoolEntry> => {
  const pool = new Map<string, AdmissionSubjectPoolEntry>();

  for (const question of questions) {
    const id = cleanString(question.id);
    const subjectId = cleanString(question.subject_id);

    // An untagged question cannot be offered as "subject preparation" without
    // guessing its subject, so it is excluded from the pool.
    if (!id || !subjectId) continue;

    let entry = pool.get(subjectId);
    if (!entry) {
      entry = { subjectId, questionIds: [], byChapter: new Map() };
      pool.set(subjectId, entry);
    }

    entry.questionIds.push(id);

    const chapterId = cleanString(question.chapter_id);
    if (!chapterId) continue;

    const chapterQuestions = entry.byChapter.get(chapterId) ?? [];
    chapterQuestions.push(id);
    entry.byChapter.set(chapterId, chapterQuestions);
  }

  return pool;
};

export interface AdmissionPaperQuestionLink {
  exam_id: string | null;
  question_id: string | null;
}

/**
 * Eligible question count per paper.
 *
 * A paper's advertised count must describe the questions a started exam can
 * actually serve. Links to questions that are inactive, unpublished or deleted
 * (absent from `eligibleQuestionIds`) are not counted, and a question linked
 * twice to one paper is counted once. Exam assignment and grading are
 * unaffected: this only derives the number shown before an attempt starts.
 */
export const countEligibleQuestionsPerPaper = (
  links: AdmissionPaperQuestionLink[],
  eligibleQuestionIds: Iterable<string>
): Map<string, number> => {
  const eligible = new Set(
    Array.from(eligibleQuestionIds, (id) => cleanString(id)).filter(
      (id): id is string => Boolean(id)
    )
  );

  const counts = new Map<string, number>();
  const seen = new Map<string, Set<string>>();

  for (const link of links) {
    const examId = cleanString(link.exam_id);

    if (!examId) continue;
    if (!counts.has(examId)) counts.set(examId, 0);

    const questionId = cleanString(link.question_id);

    if (!questionId || !eligible.has(questionId)) continue;

    const paperSeen = seen.get(examId) ?? new Set<string>();

    if (paperSeen.has(questionId)) continue;

    paperSeen.add(questionId);
    seen.set(examId, paperSeen);
    counts.set(examId, (counts.get(examId) ?? 0) + 1);
  }

  return counts;
};

const shuffle = <T>(items: T[]): T[] => {
  const copy = items.slice();

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
};

export interface PracticeSelection {
  subjectId: string;
  chapterId?: string | null;
  limit?: number | null;
  /** Disabled by tests that assert the exact selection. */
  randomize?: boolean;
}

/**
 * Question ids for one subject practice attempt. A chapter narrows the set to
 * questions from that chapter only; a subject that is not in the pool yields an
 * empty selection rather than falling back to another subject.
 */
export const selectPracticeQuestionIds = (
  pool: Map<string, AdmissionSubjectPoolEntry>,
  selection: PracticeSelection
): string[] => {
  const subjectId = cleanString(selection.subjectId);
  if (!subjectId) return [];

  const entry = pool.get(subjectId);
  if (!entry) return [];

  const chapterId = cleanString(selection.chapterId);
  const source = chapterId ? entry.byChapter.get(chapterId) ?? [] : entry.questionIds;

  const requested = Number(selection.limit);
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.trunc(requested), ADMISSION_PRACTICE_MAX_QUESTIONS)
    : ADMISSION_PRACTICE_DEFAULT_QUESTIONS;

  return (selection.randomize === false ? source.slice() : shuffle(source)).slice(0, limit);
};
