import { supabase } from '../../config/supabase';
import { ExamAttemptService } from '../exams/exam.attempt.service';
import { ADMISSION_ERROR_CODES, AdmissionError } from './admissions.errors';
import {
  buildUnitSubjectPool,
  countEligibleQuestionsPerPaper,
  groupPastExams,
  resolveModelTestNo,
  resolvePaperMode,
  resolvePaperSession,
  selectModelTests,
  selectPracticeQuestionIds,
  type AdmissionPaperQuestionLink,
  type AdmissionPaperRow,
  type AdmissionQuestionRow,
  type AdmissionSubjectPoolEntry,
} from './admissions.practice';

type AnyObject = Record<string, any>;

/** Safety bound: one admission unit never legitimately has this many papers. */
const MAX_PAPERS_PER_UNIT = 500;

interface UnitRow {
  id: string;
  institution_id: string;
  name_bn: string;
  name_en: string | null;
  code: string;
  description: string | null;
  is_active: boolean;
  display_order: number;
}

interface UnitPool {
  unit: UnitRow;
  university: AnyObject | null;
  papers: AdmissionPaperRow[];
  questionCounts: Map<string, number>;
  questions: AdmissionQuestionRow[];
  pool: Map<string, AdmissionSubjectPoolEntry>;
  subjects: Map<string, AnyObject>;
  chapters: Map<string, AnyObject>;
}

const normalizeId = (value: unknown): string => String(value ?? '').trim();

const unique = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.map(normalizeId).filter(Boolean)));

const loadActiveUnit = async (unitId: string): Promise<UnitRow> => {
  const { data, error } = await supabase
    .from('admission_units')
    .select('id, institution_id, name_bn, name_en, code, description, is_active, display_order')
    .eq('id', unitId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  // Inactive units stay hidden from students even when the id is known, so a
  // deactivated unit can never surface content through a stale link.
  if (!data || data.is_active !== true) {
    throw new AdmissionError(
      'Admission unit not found',
      404,
      ADMISSION_ERROR_CODES.UNIT_NOT_FOUND
    );
  }

  return data as UnitRow;
};

const loadUniversity = async (institutionId: string): Promise<AnyObject | null> => {
  const { data, error } = await supabase
    .from('institutions')
    .select('id, name_bn, name_en, short_name, slug, location, district')
    .eq('id', institutionId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data ?? null;
};

const loadUnitPapers = async (unitId: string): Promise<AdmissionPaperRow[]> => {
  const { data, error } = await supabase
    .from('exam_papers')
    .select(
      'id, title, title_en, subject_id, meta_data, duration_min, total_marks, is_premium, start_time, end_time, default_negative_marks, created_at'
    )
    .eq('admission_unit_id', unitId)
    .eq('category', 'admission')
    .eq('is_published', true)
    .order('created_at', { ascending: false })
    .limit(MAX_PAPERS_PER_UNIT);

  if (error) throw new Error(error.message);

  return (data ?? []) as AdmissionPaperRow[];
};

/**
 * Loads everything the unit screen and a subject practice need:
 * unit-linked published papers, their question counts, and the published
 * questions that make up the unit's subject pool.
 */
const loadUnitPool = async (unitId: string): Promise<UnitPool> => {
  const unit = await loadActiveUnit(unitId);
  const [university, papers] = await Promise.all([
    loadUniversity(unit.institution_id),
    loadUnitPapers(unit.id),
  ]);

  let links: AdmissionPaperQuestionLink[] = [];

  if (papers.length > 0) {
    const { data, error } = await supabase
      .from('exam_paper_questions')
      .select('exam_id, question_id')
      .in(
        'exam_id',
        papers.map((paper) => paper.id)
      );

    if (error) throw new Error(error.message);

    links = data ?? [];
  }

  const questionIds = unique(links.map((link) => link.question_id));
  let questions: AdmissionQuestionRow[] = [];

  if (questionIds.length > 0) {
    const { data, error } = await supabase
      .from('questions')
      .select('id, subject_id, chapter_id')
      .in('id', questionIds)
      .eq('is_active', true)
      .eq('status', 'published')
      .is('deleted_at', null);

    if (error) throw new Error(error.message);

    questions = (data ?? []) as AdmissionQuestionRow[];
  }

  // The advertised count has to be the set a started exam can serve. Question
  // eligibility is decided by the filter used to load the rows above, so
  // inactive, unpublished and deleted questions never inflate the number.
  const questionCounts = countEligibleQuestionsPerPaper(
    links,
    questions.map((question) => question.id)
  );

  const pool = buildUnitSubjectPool(questions);
  const subjectIds = [...pool.keys()];
  const chapterIds = unique(
    questions.flatMap((question) => (question.chapter_id ? [question.chapter_id] : []))
  );

  const subjects = new Map<string, AnyObject>();
  const chapters = new Map<string, AnyObject>();

  const [subjectRows, chapterRows] = await Promise.all([
    subjectIds.length > 0
      ? supabase
          .from('subjects')
          .select('id, name_bn, name_en, slug, sequence, is_premium')
          .in('id', subjectIds)
      : Promise.resolve({ data: [], error: null } as AnyObject),
    chapterIds.length > 0
      ? supabase
          .from('chapters')
          .select('id, name_bn, name_en, subject_id, sequence')
          .in('id', chapterIds)
      : Promise.resolve({ data: [], error: null } as AnyObject),
  ]);

  if (subjectRows.error) throw new Error(subjectRows.error.message);
  if (chapterRows.error) throw new Error(chapterRows.error.message);

  for (const row of (subjectRows.data ?? []) as AnyObject[]) {
    subjects.set(normalizeId(row.id), row);
  }

  for (const row of (chapterRows.data ?? []) as AnyObject[]) {
    chapters.set(normalizeId(row.id), row);
  }

  return { unit, university, papers, questionCounts, questions, pool, subjects, chapters };
};

const paperSummary = (paper: AdmissionPaperRow, questionCounts: Map<string, number>) => ({
  id: paper.id,
  title: paper.title ?? '',
  title_en: paper.title_en ?? null,
  mode: resolvePaperMode(paper),
  session: resolvePaperSession(paper),
  model_test_no: resolveModelTestNo(paper),
  duration_min: paper.duration_min ?? null,
  total_marks: paper.total_marks ?? null,
  question_count: questionCounts.get(paper.id) ?? 0,
  is_premium: paper.is_premium === true,
  start_time: paper.start_time ?? null,
  end_time: paper.end_time ?? null,
  default_negative_marks: paper.default_negative_marks ?? null,
});

const subjectSequence = (subjects: Map<string, AnyObject>, subjectId: string): number => {
  const sequence = Number(subjects.get(subjectId)?.sequence);

  return Number.isFinite(sequence) ? sequence : 9999;
};

const chapterSequence = (chapters: Map<string, AnyObject>, chapterId: string): number => {
  const sequence = Number(chapters.get(chapterId)?.sequence);

  return Number.isFinite(sequence) ? sequence : 9999;
};

export const AdmissionStudentService = {
  /** Unit screen: breadcrumb, historical papers by session, model tests, subjects. */
  async getUnitContent(unitId: string) {
    const { unit, university, papers, questionCounts, questions, pool, subjects, chapters } =
      await loadUnitPool(unitId);

    const pastExams = groupPastExams(papers).map((group) => ({
      session: group.session,
      papers: group.papers.map((paper) => paperSummary(paper, questionCounts)),
    }));

    const modelTests = selectModelTests(papers).map((paper) =>
      paperSummary(paper, questionCounts)
    );

    const subjectOptions = [...pool.values()]
      .map((entry) => {
        const subject = subjects.get(entry.subjectId);

        const chapterOptions = [...entry.byChapter.entries()]
          .map(([chapterId, ids]) => {
            const chapter = chapters.get(chapterId);

            return {
              id: chapterId,
              name_bn: chapter?.name_bn ?? '',
              name_en: chapter?.name_en ?? null,
              question_count: ids.length,
            };
          })
          .sort(
            (a, b) =>
              chapterSequence(chapters, a.id) - chapterSequence(chapters, b.id) ||
              a.name_bn.localeCompare(b.name_bn)
          );

        return {
          id: entry.subjectId,
          name_bn: subject?.name_bn ?? '',
          name_en: subject?.name_en ?? null,
          slug: subject?.slug ?? null,
          is_premium: subject?.is_premium === true,
          question_count: entry.questionIds.length,
          chapters: chapterOptions,
        };
      })
      .sort(
        (a, b) =>
          subjectSequence(subjects, a.id) - subjectSequence(subjects, b.id) ||
          a.name_bn.localeCompare(b.name_bn)
      );

    return {
      unit: {
        id: unit.id,
        institution_id: unit.institution_id,
        name_bn: unit.name_bn,
        name_en: unit.name_en ?? null,
        code: unit.code,
        description: unit.description ?? null,
        display_order: Number(unit.display_order ?? 0),
      },
      university: university
        ? {
            id: university.id,
            name_bn: university.name_bn,
            name_en: university.name_en ?? null,
            short_name: university.short_name ?? null,
            slug: university.slug ?? null,
            location: university.location ?? university.district ?? null,
          }
        : null,
      past_exams: pastExams,
      model_tests: modelTests,
      subjects: subjectOptions,
      diagnostics: {
        papers: papers.length,
        questions: questions.length,
        subjects: subjectOptions.length,
      },
    };
  },

  /**
   * Starts a unit-scoped subject practice on the existing practice engine.
   * The question set is chosen from the unit's own published pool, so a crafted
   * subject/chapter pair can never pull questions from another unit or subject.
   */
  async startSubjectPractice(
    userId: string,
    unitId: string,
    input: { subject_id: string; chapter_id: string | null; limit?: number }
  ) {
    if (!userId) throw new AdmissionError('Unauthorized', 401);

    const { pool } = await loadUnitPool(unitId);

    const questionIds = selectPracticeQuestionIds(pool, {
      subjectId: input.subject_id,
      chapterId: input.chapter_id,
      limit: input.limit,
    });

    if (questionIds.length === 0) {
      throw new AdmissionError(
        'No practice questions are available for this selection',
        404,
        ADMISSION_ERROR_CODES.PRACTICE_EMPTY
      );
    }

    const attempt = await ExamAttemptService.startPracticeAttempt(userId, questionIds);

    return {
      ...attempt,
      unit_id: unitId,
      subject_id: input.subject_id,
      chapter_id: input.chapter_id,
      question_count: questionIds.length,
    };
  },
};
