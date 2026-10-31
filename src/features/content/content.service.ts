import { randomUUID } from 'crypto';
import { supabase } from '../../config/supabase';
import { CurriculumNode, QuestionPayload, ComprehensionPayload, NodeType, AuditFilterParams } from './content.types';
import { buildQuestionContentHash, canEditQuestion, decideQuestionWrite, isPrivilegedContentRole } from './question.policy';
import { withResolvedExamReferences } from './exam-references';
import { buildIdMatchClause, joinOrClauses, normalizeSearchTerm } from '../../lib/utils/search';

const writeContentAudit = async (actorId: string, action: string, targetId: string) => {
  const { error } = await supabase.from('audit_logs').insert({
    user_id: actorId,
    action,
    target_table: 'questions',
    target_id: targetId,
    details: {},
  });
  if (error) console.error('[security-audit] content event could not be recorded');
};

export const getUserAccess = async (userId: string) => {
  const { data, error } = await supabase.rpc('get_user_access', { p_user_id: userId });
  if (error) throw new Error(error.message);
  return data;
};

export const applyLocking = (items: any[], hasPremium: boolean) => {
  return items.map(item => ({
    ...item,
    is_locked: item.is_premium && !hasPremium
  }));
};

export const getStudyMaterials = async (userId?: string) => {
  const { data, error } = await supabase
    .from('study_materials')
    .select('id, title, title_en, type, is_premium, subject_id, chapter_id, topic_id, media_id, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);

  if (!userId) return applyLocking(data, false);
  
  const access = await getUserAccess(userId);
  return applyLocking(data, !!access.premium);
};

export const getSubjects = async (userId?: string) => {
  const { data, error } = await supabase
    .from('subjects')
    .select('id, name_en, name_bn, is_premium, slug, description, sequence, is_active, icon_url, curriculum_version, language')
    .order('sequence');

  if (error) throw new Error(error.message);
  
  if (!userId) return applyLocking(data, false);
  const access = await getUserAccess(userId);
  return applyLocking(data, !!access.premium);
};

export const getChapters = async (subjectId?: string, userId?: string) => {
  let query = supabase
    .from('chapters')
    .select('id, name_en, name_bn, subject_id, is_premium, slug, description, sequence, is_active, curriculum_version, language')
    .order('sequence');

  if (subjectId) query = query.eq('subject_id', subjectId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  
  if (!userId) return applyLocking(data, false);
  const access = await getUserAccess(userId);
  return applyLocking(data, !!access.premium);
};

export const getTopics = async (chapterId?: string, userId?: string) => {
  let query = supabase
    .from('topics')
    .select('id, name_en, name_bn, chapter_id, is_premium, slug, sequence, is_active, curriculum_version, language')
    .order('sequence');

  if (chapterId) query = query.eq('chapter_id', chapterId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  
  if (!userId) return applyLocking(data, false);
  const access = await getUserAccess(userId);
  return applyLocking(data, !!access.premium);
};

/**
 * Full curriculum tree for the user app.
 *
 * Premium nodes are marked with `is_locked` using the authoritative access
 * payload so the client can render the lock state. Access failures fail closed
 * (locked), never open.
 */
export const buildCurriculumTree = async (userId?: string): Promise<CurriculumNode[]> => {
  const [subjectsRes, chaptersRes, topicsRes] = await Promise.all([
    supabase.from('subjects').select('*').order('sequence'),
    supabase.from('chapters').select('*').order('sequence'),
    supabase.from('topics').select('*').order('sequence'),
  ]);

  if (subjectsRes.error) throw new Error(subjectsRes.error.message);
  if (chaptersRes.error) throw new Error(chaptersRes.error.message);
  if (topicsRes.error) throw new Error(topicsRes.error.message);

  const subjects = subjectsRes.data ?? [];
  const chapters = chaptersRes.data ?? [];
  const topics = topicsRes.data ?? [];

  let hasPremium = false;
  if (userId) {
    try {
      const access = await getUserAccess(userId);
      hasPremium = access?.premium === true;
    } catch {
      // Fail closed: an unavailable access check must not unlock content.
      hasPremium = false;
    }
  }

  const withLock = (node: any) => ({ ...node, is_locked: node.is_premium === true && !hasPremium });

  const topicsByChapter = topics.reduce((acc: Record<string, any[]>, topic: any) => {
    if (!topic.chapter_id) return acc;
    if (!acc[topic.chapter_id]) acc[topic.chapter_id] = [];
    acc[topic.chapter_id].push(withLock({ ...topic, type: 'topic', children: [] }));
    return acc;
  }, {});

  const chaptersBySubject = chapters.reduce((acc: Record<string, any[]>, chapter: any) => {
    if (!chapter.subject_id) return acc;
    if (!acc[chapter.subject_id]) acc[chapter.subject_id] = [];
    acc[chapter.subject_id].push(
      withLock({
        ...chapter,
        type: 'chapter',
        children: topicsByChapter[chapter.id] || [],
      })
    );
    return acc;
  }, {});

  return subjects.map((subject: any) =>
    withLock({
      ...subject,
      type: 'subject',
      children: chaptersBySubject[subject.id] || [],
    })
  );
};

const pickAllowedFields = (nodeType: NodeType, rawData: Record<string, any> = {}) => {
  const allowedFieldsByType: Record<NodeType, string[]> = {
    subject: [
      'id', 'name_en', 'name_bn', 'slug', 'description', 'sequence', 'is_active', 'is_premium', 'icon_url', 'curriculum_version', 'language',
    ],
    chapter: [
      'id', 'name_en', 'name_bn', 'slug', 'description', 'sequence', 'is_active', 'is_premium', 'curriculum_version', 'language', 'subject_id',
    ],
    topic: [
      'id', 'name_en', 'name_bn', 'slug', 'sequence', 'is_active', 'is_premium', 'curriculum_version', 'language', 'chapter_id', 'total_questions',
    ],
  };

  const allowedFields = allowedFieldsByType[nodeType];
  const cleaned: Record<string, any> = {};

  for (const key of allowedFields) {
    if (rawData[key] !== undefined) {
      cleaned[key] = rawData[key];
    }
  }

  return cleaned;
};

const generateNodeId = (nodeType: NodeType): string => {
  const suffix = randomUUID().replace(/-/g, '').toLowerCase().slice(0, 16);
  if (nodeType === 'subject') return `sub_${suffix}`;
  if (nodeType === 'chapter') return `chap_${suffix}`;
  return `top_${suffix}`;
};

export const manageCurriculumNode = async (
  action: 'insert' | 'update' | 'delete',
  nodeType: NodeType,
  data: any,
  id?: string
) => {
  const table = nodeType === 'subject' ? 'subjects' : nodeType === 'chapter' ? 'chapters' : 'topics';

  if (action === 'delete') {
    if (!id) throw new Error('ID is required for delete action');
    const { error } = await supabase.from(table).delete().eq('id', id);
    if (error) throw new Error(error.message);
    return true;
  }

  const payload = pickAllowedFields(nodeType, data || {});

  if (action === 'insert') {
    // 🚀 ID যদি ফ্রন্টএন্ড থেকে আসে তাহলে সেটি ব্যবহার হবে, না হলে নতুন জেনারেট হবে
    payload.id = payload.id || generateNodeId(nodeType);
    const { data: result, error } = await supabase.from(table).insert([payload]).select().single();
    if (error) throw new Error(error.message);
    return result;
  }

  if (action === 'update') {
    if (!id) throw new Error('ID is required for update action');
    if (Object.keys(payload).length === 0) throw new Error('No valid fields provided for update');
    
    // আপডেটের সময় আইডি পরিবর্তন করা ঠিক নয়, তাই সেফটির জন্য আইডি বাদ দেওয়া হলো
    delete payload.id;
    
    const { data: result, error } = await supabase.from(table).update(payload).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return result;
  }

  throw new Error('Invalid curriculum action');
};

export const createComprehension = async (data: ComprehensionPayload) => {
  const { data: result, error } = await supabase.from('comprehensions').insert([data]).select().single();
  if (error) throw new Error(error.message);
  return result;
};

export const searchComprehensions = async (query: string) => {
  const { data, error } = await supabase
    .from('comprehensions')
    .select('id, body, subject_id, chapter_id, topic_id')
    .ilike('body', `%${query}%`)
    .limit(10);
  if (error) throw new Error(error.message);
  return data;
};

/**
 * Creates one question on behalf of the authenticated author.
 *
 * The request body is never spread into the insert: only author-editable
 * fields survive (see question.policy), status is forced to `pending` for
 * non-privileged roles, and `created_by` is taken from the verified token.
 */
export const saveSmartQuestion = async (
  questionData: QuestionPayload,
  options: { role?: string | null; userId?: string | null } = {}
) => {
  const bodyWithReferences = await withResolvedExamReferences(
    questionData as unknown as Record<string, unknown>
  );

  const { payload, status } = decideQuestionWrite({
    role: options.role,
    body: bodyWithReferences,
    mode: 'create',
  });

  // Exact duplicate check on the same canonical content hash the bulk path
  // uses, so both endpoints agree on what "already exists" means.
  const content_hash = buildQuestionContentHash(payload);

  if (payload.subject_id) {
    const { data: existing } = await supabase
      .from('questions')
      .select('id')
      .eq('subject_id', payload.subject_id as string)
      .eq('content_hash', content_hash)
      .limit(1);

    if (existing && existing.length > 0) {
      throw new Error('100% Duplicate question found. Cannot save.');
    }
  }

  // 100% legacy duplicate check based on exact JSON body match
  if (payload.body) {
    const legacyScope = supabase.from('questions').select('id').contains('body', payload.body as any);

    const { data: legacyExisting } = await (payload.subject_id
      ? legacyScope.eq('subject_id', payload.subject_id as string)
      : legacyScope
    ).limit(1);

    if (legacyExisting && legacyExisting.length > 0) {
      throw new Error('100% Duplicate question found. Cannot save.');
    }
  }

  const insertPayload = {
    ...payload,
    content_hash,
    created_by: options.userId ?? null,
  };

  const { data, error } = await supabase.from('questions').insert([insertPayload]).select().single();
  if (error) {
    if (error.code === '23505') throw new Error('Duplicate question found.');
    throw new Error(error.message);
  }

  return { ...data, review_status: status ?? data?.status };
};

/**
 * Updates one question. Non-privileged authors cannot change moderation fields
 * and any edit to the question body/options/answer returns it to review.
 */
export const updateQuestion = async (
  id: string,
  questionData: Partial<QuestionPayload>,
  options: { role?: string | null; userId?: string | null } = {}
) => {
  const bodyWithReferences = await withResolvedExamReferences(
    questionData as unknown as Record<string, unknown>
  );

  const { payload } = decideQuestionWrite({
    role: options.role,
    body: bodyWithReferences,
    mode: 'update',
  });

  if (Object.keys(payload).length === 0) {
    throw new Error('No editable fields provided for update');
  }

  const privileged = isPrivilegedContentRole(options.role);
  if (!privileged) {
    if (!options.userId) throw new Error('Question not found');
    const { data: ownedQuestion, error: ownershipError } = await supabase
      .from('questions')
      .select('created_by')
      .eq('id', id)
      .maybeSingle();
    if (ownershipError || !canEditQuestion(options.role, options.userId, ownedQuestion?.created_by)) {
      throw new Error('Question not found');
    }
  }

  if (
    payload.body !== undefined ||
    payload.options !== undefined ||
    payload.answer !== undefined
  ) {
    const { data: existingData } = await supabase
      .from('questions')
      .select('subject_id, chapter_id, topic_id, comprehension_id, type, body, options, answer, explanation, difficulty_level, source_type, tags, exam_references, media_id, explanation_media_id')
      .eq('id', id)
      .single();

    payload.content_hash = buildQuestionContentHash({ ...(existingData ?? {}), ...payload });
  }

  let updateQuery = supabase.from('questions').update(payload).eq('id', id);
  if (!privileged && options.userId) updateQuery = updateQuery.eq('created_by', options.userId);
  const { data, error } = await updateQuery.select().single();
  if (error) throw new Error(error.message);
  return data;
};

export const deleteQuestion = async (id: string) => {
  const { error } = await supabase.from('questions').update({ is_active: false, status: 'deleted' }).eq('id', id);
  if (error) throw new Error(error.message);
  return true;
};

export const fetchAiQueue = async () => {
  const { data, error } = await supabase
    .from('questions')
    .select('id, body, tags, confidence_score, status, difficulty_level, type')
    .lt('confidence_score', 70)
    .eq('status', 'review')
    .order('confidence_score', { ascending: true })
    .limit(50);
  if (error) throw new Error(error.message);
  return data;
};

export const reviewQuestion = async (id: string, status: 'approved' | 'rejected', adminId: string) => {
  const { data, error } = await supabase
    .from('questions')
    .update({ status, approved_by: adminId, approved_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  await writeContentAudit(adminId, `question.${status}`, id);
  return data;
};

export const refreshSearchIndex = async (type: 'vector' | 'global'): Promise<boolean> => {
  const rpcFunction = type === 'vector' ? 'refresh_vector_index' : 'refresh_global_index';
  const { error } = await supabase.rpc(rpcFunction);
  if (error) throw new Error(error.message);
  return true;
};

export const saveBulkQuestions = async (questionsData: any[], userId?: string) => {
  const BATCH_SIZE = 500;
  let allInsertedData: any[] = [];
  let flatQuestionsToInsert: any[] = [];

  for (const item of questionsData) {
    if (item.type === 'Comprehension') {
      const comprehensionPayload = { body: typeof item.passage === 'object' ? JSON.stringify(item.passage) : item.passage };
      const { data: compResult, error: compError } = await supabase.from('comprehensions').insert([comprehensionPayload]).select('id').single();
      if (compError) throw new Error(`Comprehension insert failed: ${compError.message}`);

      if (item.questions && Array.isArray(item.questions)) {
        for (const q of item.questions) {
          // Check for exact duplicate
          const { data: existing } = await supabase
            .from('questions')
            .select('id')
            .eq('subject_id', q.subject_id || item.subject_id)
            .contains('body', q.body)
            .limit(1);

          if (!existing || existing.length === 0) {
            flatQuestionsToInsert.push({ 
              ...q, 
              subject_id: q.subject_id || item.subject_id,
              comprehension_id: compResult.id, 
              status: q.status || 'pending', 
              created_by: userId 
            });
          }
        }
      }
    } else {
      // Check for exact duplicate
      const { data: existing } = await supabase
        .from('questions')
        .select('id')
        .eq('subject_id', item.subject_id)
        .contains('body', item.body)
        .limit(1);

      if (!existing || existing.length === 0) {
        flatQuestionsToInsert.push({ 
          ...item, 
          status: item.status || 'pending', 
          created_by: userId 
        });
      }
    }
  }

  for (let i = 0; i < flatQuestionsToInsert.length; i += BATCH_SIZE) {
    const chunk = flatQuestionsToInsert.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase.from('questions').insert(chunk).select();
    if (error) throw new Error(error.message);
    if (data) allInsertedData.push(...data);
  }
  return allInsertedData;
};

export const getAuditQuestions = async (filters: AuditFilterParams) => {
  let query = supabase.from('questions').select('id, body, options, explanation, confidence_score, difficulty_level, type, status, created_at, subject_id, chapter_id, tags').neq('status', 'deleted').order('created_at', { ascending: false });
  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
  else query = query.in('status', ['pending', 'review', 'flagged']);
  if (filters.difficulty && filters.difficulty !== 'all') query = query.eq('difficulty_level', filters.difficulty);
  if (filters.subject_id) query = query.eq('subject_id', filters.subject_id);
  if (filters.search) query = query.textSearch('search_vector', filters.search);

  const { data, error } = await query.limit(100);
  if (error) throw new Error(error.message);
  return data;
};

export const updateQuestionAuditStatus = async (id: string, status: string, notes: string | undefined, adminId: string) => {
    const updateData: any = { status, updated_at: new Date().toISOString() };
    if (status === 'approved') { updateData.approved_by = adminId; updateData.approved_at = new Date().toISOString(); }
    const { data, error } = await supabase.from('questions').update(updateData).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    await writeContentAudit(adminId, `question.status.${status}`, id);
    return data;
};

export const getFilteredQuestions = async (filters: any, page: number = 1, limit: number = 20) => {
  let query = supabase
    .from('questions')
    .select('id, body, options, explanation, difficulty_level, type, status, created_at, subject_id, chapter_id, tags, media_id', { count: 'exact' });

  if (filters.subject_id) query = query.eq('subject_id', filters.subject_id);
  if (filters.difficulty) query = query.eq('difficulty_level', filters.difficulty);
  if (filters.type) query = query.eq('type', filters.type);
  if (filters.status) query = query.eq('status', filters.status);
  
  if (filters.search) {
    // User input is escaped and length-capped before it reaches the filter
    // language; `id` is a UUID column, so it is matched exactly instead of
    // with an unsupported ilike.
    const search = normalizeSearchTerm(filters.search);

    if (search) {
      const clauses = joinOrClauses([
        buildIdMatchClause('id', filters.search.trim()),
        `body->>text_bn.ilike.%${search}%`,
        `body->>text_en.ilike.%${search}%`,
      ]);

      query = query.or(clauses);
    }
  }

  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new Error(error.message);

  return {
    data,
    total: count || 0
  };
};

export const hardDeleteQuestion = async (id: string, adminId: string) => {
  const { error } = await supabase.from('questions').delete().eq('id', id);
  if (error) throw new Error(error.message);
  await writeContentAudit(adminId, 'question.hard_deleted', id);
  return true;
};
