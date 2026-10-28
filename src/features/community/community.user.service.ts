import { supabase } from '../../config/supabase';
import { findOptionById, isAnswerCorrect } from '../exams/exam.grading';
import { notify } from '../notifications/notifications.service';

export const getLobbyDashboard = async (userId: string) => {
  const { data: profile, error: profileErr } = await supabase.from('profiles').select('current_group_id').eq('id', userId).single();
  if (profileErr) throw new Error('User profile not found');

  let myGroup = null;
  let squadActivity: any[] = [];

  if (profile?.current_group_id) {
    const { data: groupData } = await supabase.from('study_groups').select('id, name, group_level, total_xp, current_streak').eq('id', profile.current_group_id).single();
    myGroup = groupData;
    const { data: activities } = await supabase.from('group_chats').select('id, content, created_at, profiles(full_name)').eq('group_id', profile.current_group_id).order('created_at', { ascending: false }).limit(5);
    squadActivity = activities || [];
  }

  const { data: topGroups } = await supabase.from('study_groups').select('id, name, group_level, total_xp').order('total_xp', { ascending: false }).limit(10);
  return { hasGroup: !!myGroup, myGroup, topGroups: topGroups || [], squadActivity };
};

export const startFocusSession = async (userId: string, topic: string) => {
  const { data: profile } = await supabase.from('profiles').select('current_group_id').eq('id', userId).single();
  if (!profile?.current_group_id) throw new Error("You must be in a study group to start a focus session");
  const { data, error } = await supabase.from('group_focus_sessions').insert({ group_id: profile.current_group_id, started_by: userId, topic: topic, start_time: new Date().toISOString() }).select().single();
  if (error) throw new Error(`Failed to start focus session: ${error.message}`);
  return data;
};

export const initiateBattle = async (userId: string) => {
  const { data: profile } = await supabase.from('profiles').select('current_group_id').eq('id', userId).single();
  if (!profile?.current_group_id) throw new Error("Join a group first to challenge others!");
  const { data, error } = await supabase.from('group_battles').insert({ initiated_by: userId, group_id: profile.current_group_id, status: 'pending' }).select().single();
  if (error) throw new Error(`Failed to initiate battle: ${error.message}`);
  return data;
};

export const sendBuzz = async (senderId: string, targetUserId: string) => {
  if (!targetUserId || targetUserId === senderId) return true;

  await notify({
    userIds: targetUserId,
    type: 'social',
    eventCode: 'community_buzz',
    title: { bn: 'বাজ! 🔔', en: 'Buzz! 🔔' },
    body: {
      bn: 'আপনার গ্রুপের কেউ লবি বা স্টাডি সেশনে যোগ দেওয়ার জন্য ডাক দিয়েছে!',
      en: 'Your teammate just buzzed you to join the lobby/study session!',
    },
    channels: ['in_app'],
    actionLink: '/groups',
    dedupeKey: `buzz:${senderId}:${targetUserId}:${new Date().toISOString().slice(0, 13)}`,
  });

  return true;
};

export const rewardFirstTimeGroupJoin = async (userId: string) => {
  // Use a sensible default of 100 if not set in config
  await supabase.rpc('update_user_progress', { p_coins: 0, p_user_id: userId, p_xp: 100 });
};

export const rewardGroupBattleWin = async (groupId: string) => {
  const { data } = await supabase.from('app_configs').select('value').eq('key', 'xp_rules').maybeSingle();
  const xp = (data?.value as any)?.group_battle_win || 200;

  const { data: members } = await supabase.from('group_members').select('user_id').eq('group_id', groupId);
  if (members && members.length > 0) {
    for (const member of members) {
      if (member.user_id) {
        await supabase.rpc('update_user_progress', { p_coins: 0, p_user_id: member.user_id, p_xp: xp });
      }
    }
  }
};

// =====================================
// Community challenges (group battles)
// =====================================

/**
 * A challenge is a `group_battles` row plus the exam paper it references.
 *
 * Answer keys are graded on the server only. Nothing in a challenge read may
 * expose a correct-option flag, and a submission accepts selected option ids
 * only — never a client-computed score or elapsed time.
 */
export class ChallengeError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ChallengeError';
    this.status = status;
  }
}

type AnyObject = Record<string, any>;

const SUBMISSION_KEY = '_submissions';
const MAX_CHALLENGE_QUESTIONS = 100;
const MAX_CHALLENGE_SECONDS = 24 * 60 * 60;

const normalizeId = (value: unknown): string => String(value ?? '').trim();

const parseSnapshot = (value: unknown): AnyObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as AnyObject) } : {};

const participantIds = (snapshot: AnyObject): string[] =>
  Object.keys(snapshot).filter((key) => !key.startsWith('_'));

const isParticipant = (snapshot: AnyObject, userId: string, initiatedBy: string | null): boolean =>
  participantIds(snapshot).includes(userId) || normalizeId(initiatedBy) === userId;

const loadChallengeRow = async (challengeId: string) => {
  const { data, error } = await supabase
    .from('group_battles')
    .select('id, exam_id, group_id, initiated_by, status, scores_snapshot, start_time, end_time, winner_id')
    .eq('id', challengeId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data ?? null;
};

const loadChallengeQuestions = async (examId: string) => {
  const { data: links, error: linkError } = await supabase
    .from('exam_paper_questions')
    .select('question_id, sequence')
    .eq('exam_id', examId);

  if (linkError) throw new Error(linkError.message);

  const orderedIds = (links || [])
    .slice()
    .sort((a: AnyObject, b: AnyObject) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0))
    .map((row: AnyObject) => normalizeId(row.question_id))
    .filter(Boolean)
    .slice(0, MAX_CHALLENGE_QUESTIONS);

  if (orderedIds.length === 0) return [];

  const { data: questions, error } = await supabase
    .from('questions')
    .select('id, body, options, type, difficulty_level')
    .in('id', orderedIds)
    .eq('is_active', true)
    .eq('status', 'published')
    .is('deleted_at', null);

  if (error) throw new Error(error.message);

  const byId = new Map<string, AnyObject>();
  (questions || []).forEach((question: AnyObject) => byId.set(normalizeId(question.id), question));

  return orderedIds
    .map((id) => byId.get(id))
    .filter((question): question is AnyObject => Boolean(question));
};

/** Public projection: question text and options only — never the key. */
const toPublicChallengeQuestion = (question: AnyObject) => {
  const body = question.body && typeof question.body === 'object' ? question.body : {};
  const text =
    (typeof body.text_bn === 'string' && body.text_bn.trim()) ||
    (typeof body.text_en === 'string' && body.text_en.trim()) ||
    '';

  const options = Array.isArray(question.options) ? question.options : [];

  return {
    id: normalizeId(question.id),
    text,
    type: question.type ?? null,
    difficulty_level: question.difficulty_level ?? null,
    image_url: typeof body.image_url === 'string' ? body.image_url : null,
    options: options.map((option: AnyObject) => ({
      id: normalizeId(option?.id),
      text:
        (typeof option?.text_bn === 'string' && option.text_bn.trim()) ||
        (typeof option?.text_en === 'string' && option.text_en.trim()) ||
        '',
      image_url: typeof option?.image_url === 'string' ? option.image_url : null,
    })),
  };
};

const loadParticipantProfile = async (userId: string) => {
  const { data } = await supabase
    .from('profiles')
    .select('id, full_name, username, avatar_url')
    .eq('id', userId)
    .maybeSingle();

  return data ?? null;
};

export const getChallenge = async (userId: string, challengeId: string) => {
  if (!userId) throw new ChallengeError('Unauthorized', 401);

  const normalizedId = normalizeId(challengeId);

  if (!normalizedId) throw new ChallengeError('Challenge id is required', 400);

  const battle = await loadChallengeRow(normalizedId);

  if (!battle) throw new ChallengeError('Challenge not found', 404);

  const snapshot = parseSnapshot(battle.scores_snapshot);

  if (!isParticipant(snapshot, userId, battle.initiated_by ?? null)) {
    throw new ChallengeError('You are not a participant in this challenge', 403);
  }

  if (!battle.exam_id) throw new ChallengeError('Challenge has no exam paper', 409);

  const questions = await loadChallengeQuestions(battle.exam_id);
  const participants = participantIds(snapshot);
  const opponentId = participants.find((participant) => participant !== userId) ?? null;
  const opponentProfile = opponentId ? await loadParticipantProfile(opponentId) : null;

  const submissions =
    snapshot[SUBMISSION_KEY] && typeof snapshot[SUBMISSION_KEY] === 'object'
      ? (snapshot[SUBMISSION_KEY] as AnyObject)
      : {};

  const mySubmission = submissions[userId] ?? null;
  const opponentSubmission = opponentId ? submissions[opponentId] ?? null : null;

  return {
    id: battle.id,
    exam_id: battle.exam_id,
    group_id: battle.group_id ?? null,
    status: battle.status ?? 'pending',
    start_time: battle.start_time ?? null,
    end_time: battle.end_time ?? null,
    deadline_at: battle.end_time ?? null,
    server_time: new Date().toISOString(),
    questions: questions.map(toPublicChallengeQuestion),
    question_count: questions.length,
    opponent: {
      id: opponentId,
      name: opponentProfile?.full_name || opponentProfile?.username || 'প্রতিপক্ষ',
      avatar_url: opponentProfile?.avatar_url ?? null,
      score: Number(snapshot[opponentId ?? ''] ?? 0),
      time_taken: Number(opponentSubmission?.time_taken ?? 0),
    },
    you: {
      id: userId,
      score: Number(snapshot[userId] ?? 0),
      time_taken: Number(mySubmission?.time_taken ?? 0),
    },
    submitted: Boolean(mySubmission),
    result: mySubmission
      ? {
          score: Number(mySubmission.score ?? 0),
          total: Number(mySubmission.total ?? questions.length),
          time_taken: Number(mySubmission.time_taken ?? 0),
          submitted_at: mySubmission.submitted_at ?? null,
          duplicate: true,
        }
      : null,
  };
};

/**
 * Grades and records one participant's answers.
 *
 * Idempotent per (user, challenge): a second submission returns the first
 * stored result instead of grading again or overwriting the score.
 */
export const submitChallenge = async (
  userId: string,
  challengeId: string,
  body: AnyObject
) => {
  if (!userId) throw new ChallengeError('Unauthorized', 401);

  const normalizedId = normalizeId(challengeId);

  if (!normalizedId) throw new ChallengeError('Challenge id is required', 400);

  // Client-calculated results are never trusted. They are rejected outright so
  // an outdated client cannot silently keep scoring locally.
  if (
    body?.challenger_score !== undefined ||
    body?.challenger_time_taken !== undefined ||
    body?.score !== undefined
  ) {
    throw new ChallengeError(
      'Submit selected answers only; scores are computed by the server',
      400
    );
  }

  const rawAnswers = body?.answers;

  if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
    throw new ChallengeError('answers is required', 400);
  }

  const battle = await loadChallengeRow(normalizedId);

  if (!battle) throw new ChallengeError('Challenge not found', 404);

  const snapshot = parseSnapshot(battle.scores_snapshot);

  if (!isParticipant(snapshot, userId, battle.initiated_by ?? null)) {
    throw new ChallengeError('You are not a participant in this challenge', 403);
  }

  if (!battle.exam_id) throw new ChallengeError('Challenge has no exam paper', 409);

  const existingSubmissions =
    snapshot[SUBMISSION_KEY] && typeof snapshot[SUBMISSION_KEY] === 'object'
      ? (snapshot[SUBMISSION_KEY] as AnyObject)
      : {};

  if (existingSubmissions[userId]) {
    return {
      challenge_id: normalizedId,
      score: Number(existingSubmissions[userId].score ?? 0),
      total: Number(existingSubmissions[userId].total ?? 0),
      time_taken: Number(existingSubmissions[userId].time_taken ?? 0),
      submitted_at: existingSubmissions[userId].submitted_at ?? null,
      duplicate: true,
      message: 'This challenge has already been submitted',
    };
  }

  const questions = await loadChallengeQuestions(battle.exam_id);

  if (questions.length === 0) {
    throw new ChallengeError('Challenge question set is not configured', 409);
  }

  const answers = rawAnswers as Record<string, unknown>;
  const allowedQuestionIds = new Set(questions.map((question) => normalizeId(question.id)));

  for (const [questionId, optionId] of Object.entries(answers)) {
    if (!allowedQuestionIds.has(normalizeId(questionId))) {
      throw new ChallengeError(`Question ${questionId} does not belong to this challenge`, 400);
    }

    if (optionId === null || optionId === undefined || String(optionId).trim() === '') continue;

    const question = questions.find((item) => normalizeId(item.id) === normalizeId(questionId));
    const options = Array.isArray(question?.options) ? question!.options : [];

    if (!findOptionById(options, optionId)) {
      throw new ChallengeError(`Option does not belong to question ${questionId}`, 400);
    }
  }

  let correctCount = 0;

  questions.forEach((question) => {
    const selected = answers[normalizeId(question.id)];

    if (selected === null || selected === undefined || String(selected).trim() === '') return;

    const options = Array.isArray(question.options) ? question.options : [];

    if (isAnswerCorrect(options, selected)) correctCount += 1;
  });

  const now = Date.now();
  const startedAt = battle.start_time ? Date.parse(String(battle.start_time)) : NaN;
  const elapsedSeconds = Number.isFinite(startedAt)
    ? Math.max(0, Math.min(Math.round((now - startedAt) / 1000), MAX_CHALLENGE_SECONDS))
    : 0;

  const submission = {
    score: correctCount,
    total: questions.length,
    time_taken: elapsedSeconds,
    submitted_at: new Date(now).toISOString(),
  };

  const nextSnapshot: AnyObject = {
    ...snapshot,
    [userId]: correctCount,
    [SUBMISSION_KEY]: {
      ...existingSubmissions,
      [userId]: submission,
    },
  };

  const participants = participantIds({ ...snapshot, [userId]: correctCount });
  const everyoneSubmitted =
    participants.length > 0 && participants.every((participant) => nextSnapshot[SUBMISSION_KEY][participant]);

  let winnerId: string | null = battle.winner_id ?? null;
  let nextStatus = battle.status ?? 'pending';

  if (everyoneSubmitted) {
    nextStatus = 'completed';

    const ranked = participants
      .map((participant) => ({
        participant,
        score: Number(nextSnapshot[SUBMISSION_KEY][participant]?.score ?? 0),
        time: Number(nextSnapshot[SUBMISSION_KEY][participant]?.time_taken ?? 0),
      }))
      .sort((a, b) => b.score - a.score || a.time - b.time);

    const [first, second] = ranked;
    winnerId =
      first && second && first.score === second.score && first.time === second.time
        ? null
        : first?.participant ?? null;
  } else if (nextStatus === 'pending') {
    nextStatus = 'ongoing';
  }

  const { error } = await supabase
    .from('group_battles')
    .update({
      scores_snapshot: nextSnapshot,
      status: nextStatus,
      winner_id: winnerId,
    })
    .eq('id', normalizedId)
    .eq('status', battle.status ?? 'pending');

  if (error) throw new Error(error.message);

  return {
    challenge_id: normalizedId,
    score: correctCount,
    total: questions.length,
    time_taken: elapsedSeconds,
    submitted_at: submission.submitted_at,
    correct_count: correctCount,
    wrong_count: questions.length - correctCount,
    winner_id: winnerId,
    status: nextStatus,
    duplicate: false,
    // The authoritative result is returned; per-question keys are not.
  };
};
