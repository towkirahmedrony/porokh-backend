import { supabase } from '../../config/supabase';

export const VERIFICATION_STAGES = ['answer', 'translation', 'final'] as const;
export const VERIFICATION_STATUSES = ['pending', 'verified', 'rejected'] as const;

export type VerificationStage = (typeof VERIFICATION_STAGES)[number];
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export type QuestionVerification = {
  id: string;
  question_id: string;
  stage: VerificationStage;
  status: VerificationStatus;
  verified_by: string | null;
  verified_at: string | null;
  question_revision: number;
  content_fingerprint: string;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

const isStage = (value: string): value is VerificationStage =>
  (VERIFICATION_STAGES as readonly string[]).includes(value);

const isStatus = (value: string): value is VerificationStatus =>
  (VERIFICATION_STATUSES as readonly string[]).includes(value);

const loadQuestionSnapshot = async (questionId: string) => {
  const { data, error } = await supabase
    .from('questions')
    .select('id, revision, content_fingerprint')
    .eq('id', questionId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error('Question not found');
  if (typeof data.revision !== 'number' || !data.content_fingerprint) {
    throw new Error('Question is missing revision or content fingerprint');
  }

  return data as { id: string; revision: number; content_fingerprint: string };
};

export const getQuestionVerifications = async (questionId: string) => {
  const question = await loadQuestionSnapshot(questionId);
  const { data, error } = await supabase
    .from('question_verifications')
    .select('id, question_id, stage, status, verified_by, verified_at, question_revision, content_fingerprint, notes, metadata, created_at, updated_at')
    .eq('question_id', questionId)
    .eq('question_revision', question.revision)
    .eq('content_fingerprint', question.content_fingerprint)
    .order('stage', { ascending: true });

  if (error) throw new Error(error.message);

  return {
    question_revision: question.revision,
    content_fingerprint: question.content_fingerprint,
    stages: (data ?? []) as QuestionVerification[],
  };
};

export const updateQuestionVerification = async ({
  questionId,
  stage: rawStage,
  status: rawStatus,
  notes,
  actorId,
}: {
  questionId: string;
  stage: string;
  status: string;
  notes?: string;
  actorId: string;
}) => {
  if (!isStage(rawStage)) throw new Error('Invalid verification stage');
  if (!isStatus(rawStatus)) throw new Error('Invalid verification status');

  const question = await loadQuestionSnapshot(questionId);
  const now = new Date().toISOString();
  const completed = rawStatus !== 'pending';
  const payload = {
    question_id: questionId,
    stage: rawStage,
    status: rawStatus,
    verified_by: completed ? actorId : null,
    verified_at: completed ? now : null,
    question_revision: question.revision,
    content_fingerprint: question.content_fingerprint,
    notes: notes?.trim() || null,
    updated_at: now,
  };

  const { data, error } = await supabase
    .from('question_verifications')
    .upsert(payload, {
      onConflict: 'question_id,stage,question_revision,content_fingerprint',
    })
    .select('id, question_id, stage, status, verified_by, verified_at, question_revision, content_fingerprint, notes, metadata, created_at, updated_at')
    .single();

  if (error) throw new Error(error.message);

  const { error: auditError } = await supabase.from('audit_logs').insert({
    user_id: actorId,
    action: `question.verification.${rawStage}.${rawStatus}`,
    target_table: 'question_verifications',
    target_id: data.id,
    details: { question_id: questionId, question_revision: question.revision },
  });
  if (auditError) console.error('[security-audit] verification event could not be recorded');

  return data as QuestionVerification;
};
