import { supabase } from '../../config/supabase';
import { ComprehensionPayload, QuestionPayload } from './content.types';
import type { TablesInsert, TablesUpdate } from '../../types/database.type';
import { autoCreateMissingInstitutions } from './institution.service';
import { buildQuestionContentHash, decideQuestionWrite } from './question.policy';
import { resolveExamReferenceLists, withResolvedExamReferences } from './exam-references';
import { buildIdMatchClause, joinOrClauses, normalizeSearchTerm } from '../../lib/utils/search';

export interface QuestionBankFilters {
  subject_id?: string;
  chapter_id?: string;
  topic_id?: string;
  difficulty?: string;
  type?: string;
  status?: string;
  search?: string;
  institution_type?: string;
  institution_id?: string;
  year?: string;
}

export interface QuestionBankStats {
  total: number;
  published: number;
  approved: number;
  pending: number;
  review: number;
  draft: number;
  archived: number;
  deleted: number;
  rejected: number;
  flagged: number;
  withExplanation: number;
  withoutExplanation: number;
  withMedia: number;
  withoutCorrectAnswer: number;
}

export interface QuestionBankResult {
  data: unknown[];
  pagination: any;
  stats: QuestionBankStats;
}

const hasExplanation = (q: any) => !!q.explanation;
const hasCorrectAnswer = (q: any) => !!q.options?.some((o: any) => o.is_correct);
const hasMedia = (q: any) => !!q.media_id || !!q.explanation_media_id;

const QUESTION_BANK_SELECT = `
  id, body, options, explanation, difficulty_level, type, status, created_at, updated_at, subject_id, chapter_id, topic_id, tags, media_id, explanation_media_id, source_type, exam_references, is_active, confidence_score
`;

const STATUS_KEYS: Array<keyof Pick<QuestionBankStats, 'published' | 'approved' | 'pending' | 'review' | 'draft' | 'archived' | 'deleted' | 'rejected' | 'flagged'>> = [
  'published', 'approved', 'pending', 'review', 'draft', 'archived', 'deleted', 'rejected', 'flagged',
];

const applyQuestionBankFilters = <T extends any>(
  query: T,
  filters: QuestionBankFilters,
  options: { includeStatus?: boolean } = { includeStatus: true }
): T => {
  let nextQuery = query as any;

  if (filters.subject_id) nextQuery = nextQuery.eq('subject_id', filters.subject_id);
  if (filters.chapter_id) nextQuery = nextQuery.eq('chapter_id', filters.chapter_id);
  if (filters.topic_id) nextQuery = nextQuery.eq('topic_id', filters.topic_id);
  if (filters.difficulty) nextQuery = nextQuery.eq('difficulty_level', filters.difficulty);
  if (filters.type) nextQuery = nextQuery.eq('type', filters.type);

  if (options.includeStatus !== false && filters.status) {
    if (filters.status === 'active') {
      nextQuery = nextQuery.not('status', 'in', '("deleted","archived")');
    } else {
      nextQuery = nextQuery.eq('status', filters.status);
    }
  }

  if (filters.search) {
    // Escaped, length-capped input only. `questions.id` is a UUID column, so an
    // identifier search is an exact match and never an `ilike` pattern.
    const search = normalizeSearchTerm(filters.search);

    if (search) {
      nextQuery = nextQuery.or(
        joinOrClauses([
          buildIdMatchClause('id', filters.search.trim()),
          `type.ilike.%${search}%`,
          `difficulty_level.ilike.%${search}%`,
          `source_type.ilike.%${search}%`,
          `body->>text_bn.ilike.%${search}%`,
          `body->>text_en.ilike.%${search}%`,
          `body->>bn.ilike.%${search}%`,
          `body->>en.ilike.%${search}%`,
        ])
      );
    }
  }

  return nextQuery as T;
};

const getExactCount = async (filters: QuestionBankFilters, options: { includeStatus?: boolean; statusOverride?: string } = {}): Promise<number> => {
  let query = supabase.from('questions').select('id', { count: 'exact', head: true });
  query = applyQuestionBankFilters(query, { ...filters, status: options.statusOverride ?? filters.status }, { includeStatus: options.includeStatus });
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count || 0;
};

const buildQuestionBankStats = async (filters: QuestionBankFilters, pageData: Record<string, unknown>[], total: number): Promise<QuestionBankStats> => {
  const scopeFiltersWithoutStatus: QuestionBankFilters = { ...filters, status: undefined };

  const statusCounts = await Promise.all(
    STATUS_KEYS.map(async (status) => {
      const count = await getExactCount(scopeFiltersWithoutStatus, { includeStatus: true, statusOverride: status });
      return [status, count] as const;
    })
  );

  const statusStats = statusCounts.reduce((acc, [status, count]) => {
    acc[status] = count;
    return acc;
  }, {} as Record<(typeof STATUS_KEYS)[number], number>);

  let qualityScopeQuery = supabase.from('questions').select('id, explanation, media_id, explanation_media_id, options, type').limit(5000);
  qualityScopeQuery = applyQuestionBankFilters(qualityScopeQuery, filters);
  const { data: qualityRows, error: qualityError } = await qualityScopeQuery;

  if (qualityError) throw new Error(qualityError.message);

  const qualityData = ((qualityRows?.length ? qualityRows : pageData) || []) as Record<string, unknown>[];
  const withExplanation = qualityData.filter(hasExplanation).length;
  const withMedia = qualityData.filter(hasMedia).length;
  const withoutCorrectAnswer = qualityData.filter((question) => !hasCorrectAnswer(question)).length;

  return {
    total,
    published: statusStats.published || 0,
    approved: statusStats.approved || 0,
    pending: statusStats.pending || 0,
    review: statusStats.review || 0,
    draft: statusStats.draft || 0,
    archived: statusStats.archived || 0,
    deleted: statusStats.deleted || 0,
    rejected: statusStats.rejected || 0,
    flagged: statusStats.flagged || 0,
    withExplanation,
    withoutExplanation: Math.max(total - withExplanation, 0),
    withMedia,
    withoutCorrectAnswer,
  };
};

export const createComprehension = async (data: ComprehensionPayload) => {
  const { data: result, error } = await supabase.from('comprehensions').insert(data as TablesInsert<'comprehensions'>).select().single();
  if (error) throw new Error(error.message);
  return result;
};

export const saveSmartQuestion = async (
  questionData: QuestionPayload,
  options: { role?: string | null; userId?: string | null } = {}
) => {
  const bodyWithReferences = await withResolvedExamReferences(
    questionData as unknown as Record<string, unknown>
  );

  const { payload } = decideQuestionWrite({
    role: options.role,
    body: bodyWithReferences,
    mode: 'create',
  });

  const payloadToInsert: TablesInsert<'questions'> = {
    ...(payload as unknown as TablesInsert<'questions'>),
    explanation: payload.explanation as unknown as any,
    content_hash: buildQuestionContentHash(payload),
    created_by: options.userId ?? null,
  } as TablesInsert<'questions'>;

  const { data, error } = await supabase.from('questions').insert(payloadToInsert).select().single();
  if (error) {
    if (error.code === '23505') throw new Error('Duplicate question found.');
    throw new Error(error.message);
  }
  return data;
};

export const updateQuestion = async (
  id: string,
  questionData: Partial<QuestionPayload>,
  options: { role?: string | null } = {}
) => {
  const bodyWithReferences = await withResolvedExamReferences(
    questionData as unknown as Record<string, unknown>
  );

  const { payload } = decideQuestionWrite({
    role: options.role,
    body: bodyWithReferences,
    mode: 'update',
  });

  const safeData: TablesUpdate<'questions'> = { ...(payload as unknown as TablesUpdate<'questions'>) };

  if (safeData.body || safeData.options || safeData.answer || safeData.type || safeData.difficulty_level) {
    const { data: existingData } = await supabase
      .from('questions')
      .select('subject_id, chapter_id, topic_id, comprehension_id, type, body, options, answer, explanation, difficulty_level, source_type, tags, exam_references, media_id, explanation_media_id')
      .eq('id', id)
      .single();

    safeData.content_hash = buildQuestionContentHash({
      ...((existingData as Record<string, unknown>) ?? {}),
      ...payload,
    });
  }

  const { data, error } = await supabase.from('questions').update(safeData).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
};

export const deleteQuestion = async (id: string) => {
  const { error } = await supabase.from('questions').update({ is_active: false, status: 'deleted' }).eq('id', id);
  if (error) throw new Error(error.message);
  return true;
};

export const saveBulkQuestions = async (
  questionsData: Record<string, unknown>[],
  userId?: string,
  options: { role?: string | null } = {}
) => {
  try {
    await autoCreateMissingInstitutions(questionsData);
  } catch (error) {
    console.error('Error auto-creating institutions:', error);
  }

  const BATCH_SIZE = 500;
  const allInsertedData: unknown[] = [];
  const flatQuestionsToInsert: TablesInsert<'questions'>[] = [];

  // Resolve every reference list in one pass so a bulk import does not run a
  // pair of lookup queries per question. Validation happens before any
  // question insert, and unknown reference keys are carried through untouched.
  const referenceTargets: Record<string, unknown>[] = [];
  for (const item of questionsData) {
    if (item.type === 'Comprehension' && Array.isArray(item.questions)) {
      for (const question of item.questions as Record<string, unknown>[]) {
        if (Object.prototype.hasOwnProperty.call(question, 'exam_references')) {
          referenceTargets.push(question);
        }
      }
    } else if (Object.prototype.hasOwnProperty.call(item, 'exam_references')) {
      referenceTargets.push(item as Record<string, unknown>);
    }
  }

  if (referenceTargets.length > 0) {
    const resolvedLists = await resolveExamReferenceLists(
      referenceTargets.map((target) => target.exam_references)
    );
    referenceTargets.forEach((target, index) => {
      target.exam_references = resolvedLists[index];
    });
  }

  for (const item of questionsData) {
    if (item.type === 'Comprehension') {
      const passageBody = typeof item.passage === 'object' ? JSON.stringify(item.passage) : (item.passage as string);
      const comprehensionPayload: TablesInsert<'comprehensions'> = { body: passageBody };
      const { data: compResult, error: compError } = await supabase.from('comprehensions').insert(comprehensionPayload).select('id').single();

      if (compError) throw new Error(compError.message);

      if (Array.isArray(item.questions)) {
        for (const question of item.questions as Record<string, unknown>[]) {
          const { payload } = decideQuestionWrite({
            role: options.role,
            body: question,
            mode: 'create',
          });

          const scoped: Record<string, unknown> = {
            ...payload,
            subject_id: (question.subject_id as string) || (item.subject_id as string),
            chapter_id: (question.chapter_id as string) || (item.chapter_id as string),
            topic_id: (question.topic_id as string) || (item.topic_id as string),
            comprehension_id: compResult.id,
          };

          flatQuestionsToInsert.push({
            ...(scoped as unknown as TablesInsert<'questions'>),
            explanation: scoped.explanation as unknown as any,
            is_embedding_stale: true,
            created_by: userId,
            // Same canonicalisation as the single-question path, computed after
            // the comprehension/scope fields are resolved.
            content_hash: buildQuestionContentHash(scoped),
          });
        }
      }
    } else {
      const { payload } = decideQuestionWrite({
        role: options.role,
        body: item,
        mode: 'create',
      });

      flatQuestionsToInsert.push({
        ...(payload as unknown as TablesInsert<'questions'>),
        explanation: payload.explanation as unknown as any,
        is_embedding_stale: true,
        created_by: userId,
        content_hash: buildQuestionContentHash(payload),
      });
    }
  }

  for (let index = 0; index < flatQuestionsToInsert.length; index += BATCH_SIZE) {
    const chunk = flatQuestionsToInsert.slice(index, index + BATCH_SIZE);
    const { data, error } = await supabase.from('questions').upsert(chunk, { onConflict: 'subject_id, content_hash', ignoreDuplicates: true }).select();
    if (error) throw new Error(error.message);
    if (data) allInsertedData.push(...data);
  }

  return allInsertedData;
};

export const getFilteredQuestions = async (filters: QuestionBankFilters, page: number = 1, limit: number = 20): Promise<QuestionBankResult> => {
  
  let query = supabase.from('questions').select(QUESTION_BANK_SELECT, { count: 'exact' });

  // 🚀 1. Institution Dynamic Resolving & JSONB Filtering
  if (filters.institution_id && filters.institution_id !== 'all') {
    const { data: inst } = await supabase.from('institutions').select('name_bn, name_en, aliases, code, eiin').eq('code', filters.institution_id).single();
    
    if (inst) {
      const orClauses: string[] = [];
      
      // Helper function to correctly format JSONB contains queries
      const addClause = (key: string, val: string | number) => {
        const valStr = String(val);
        // কমা থাকলে skip করছি কারণ কমা PostgREST এর .or() break করে দেয়
        if (!valStr || valStr.includes(',')) return; 
        const jsonStr = JSON.stringify([{ [key]: val }]);
        orClauses.push(`exam_references.cs.${jsonStr}`);
      };

      addClause('code', inst.code);
      addClause('eiin', inst.code); // Fallback: If code is mistakenly saved as EIIN in questions
      if (inst.eiin) addClause('eiin', inst.eiin);
      
      const terms = [...new Set([inst.name_bn, inst.name_en, ...(inst.aliases || [])])].filter(Boolean);
      for (const term of terms) {
        addClause('board', term);
        addClause('institution_name', term);
        addClause('name', term);
      }

      if (orClauses.length > 0) {
        query = query.or(orClauses.join(','));
      } else {
        query = query.contains('exam_references', JSON.stringify([{ code: filters.institution_id }]));
      }
    } else {
      query = query.contains('exam_references', JSON.stringify([{ code: filters.institution_id }]));
    }
  } else if (filters.institution_type && filters.institution_type !== 'all') {
    query = query.contains('exam_references', JSON.stringify([{ source_kind: filters.institution_type }]));
  }

  // 🚀 2. Year Filtering (Handling both String and Number types in JSONB)
  if (filters.year && filters.year !== 'all') {
    const yearStr = filters.year.trim();
    const yearNum = Number(yearStr);
    const yearOrClauses: string[] = [];
    
    const addYearClause = (key: string, val: string | number) => {
      const jsonStr = JSON.stringify([{ [key]: val }]);
      yearOrClauses.push(`exam_references.cs.${jsonStr}`);
    };

    addYearClause('year', yearStr);
    addYearClause('exam_year', yearStr);
    if (!isNaN(yearNum)) {
      addYearClause('year', yearNum);
      addYearClause('exam_year', yearNum);
    }
    
    query = query.or(yearOrClauses.join(','));
  }

  // Apply basic filters
  query = applyQuestionBankFilters(query, filters);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
  const from = (safePage - 1) * safeLimit;
  const to = from + safeLimit - 1;

  const { data, count, error } = await query.order('created_at', { ascending: false }).range(from, to);
  if (error) throw new Error(error.message);

  const rows = (data || []) as unknown[];
  const total = count || 0;
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  const stats = await buildQuestionBankStats(filters, rows as Record<string, unknown>[], total);

  return {
    data: rows,
    pagination: { page: safePage, limit: safeLimit, total, totalPages, hasNextPage: safePage < totalPages, hasPreviousPage: safePage > 1 },
    stats,
  };
};

export const hardDeleteQuestion = async (id: string) => {
  const { error } = await supabase.from('questions').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return true;
};

export const refreshSearchIndex = async (type: 'vector' | 'global'): Promise<boolean> => {
  const rpcFunction = type === 'vector' ? 'refresh_vector_index' : 'refresh_global_index';
  const { error } = await supabase.rpc(rpcFunction);
  if (error) throw new Error(error.message);
  return true;
};
