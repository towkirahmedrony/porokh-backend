import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../../config/supabaseAdmin';
import {
  loadGroupBattleQuestions,
  sanitizeQuestionsForClient,
  selectGroupBattleQuestionIds,
} from '../exams/exams.user.service';
import { groupError, mapDataError } from './groups.errors';
import { deriveBattleState, finalizableAt } from './groups.battleState';
import { computeTimeTaken, scoreBattleAnswers } from './groups.scoring';
import {
  getGroupRow,
  loadSafeProfiles,
  notifyBattleCreated,
  notifyBattleFinished,
  requireActiveMember,
  requireGroupAdmin,
} from './groups.service';

type AnyObject = Record<string, any>;

/** `question_ids` is intentionally excluded from every client projection. */
const BATTLE_FIELDS =
  'id, group_id, title, initiated_by, status, duration_minutes, subject_id, chapter_id, start_time, end_time, participant_count, winner_id, scores_snapshot, created_at';

const MIN_BATTLE_QUESTIONS = 5;
const MAX_BATTLE_QUESTIONS = 50;
const MAX_BATTLE_DURATION_MINUTES = 180;
const FINALIZE_GRACE_MS = 2 * 60 * 1000;

const normalizeId = (value: unknown): string => String(value ?? '').trim();

const toEpoch = (value: unknown): number | null => {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

const loadBattle = async (
  client: SupabaseClient,
  battleId: string
): Promise<AnyObject | null> => {
  const { data, error } = await client
    .from('group_battles')
    .select(BATTLE_FIELDS)
    .eq('id', battleId)
    .maybeSingle();

  if (error) throw mapDataError(error);
  return data ?? null;
};

/**
 * question_ids is server-only. It is read with the service-role client after
 * group membership has been proven, so a future RLS tightening on
 * group_battles cannot break live play nor leak the ids to the browser.
 */
const loadBattleQuestionIds = async (battleId: string): Promise<string[]> => {
  const { data, error } = await supabaseAdmin
    .from('group_battles')
    .select('question_ids')
    .eq('id', battleId)
    .maybeSingle();

  if (error) throw mapDataError(error);
  return Array.isArray(data?.question_ids)
    ? data.question_ids.map(normalizeId).filter(Boolean)
    : [];
};

const withState = (battle: AnyObject, nowMs: number) => ({
  ...battle,
  state: deriveBattleState(battle, nowMs),
  finalizable_at: finalizableAt(battle.end_time),
});

const loadParticipant = async (
  client: SupabaseClient,
  battleId: string,
  userId: string
): Promise<AnyObject | null> => {
  const { data, error } = await client
    .from('group_battle_participants')
    .select('id, battle_id, user_id, status, score, correct_count, wrong_count, time_taken, rank, xp_awarded, joined_at, submitted_at')
    .eq('battle_id', battleId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw mapDataError(error);
  return data ?? null;
};

export const createBattle = async (
  client: SupabaseClient,
  userId: string,
  groupId: string,
  input: {
    title: string;
    subjectId?: string | null;
    chapterId?: string | null;
    questionCount: number;
    durationMinutes: number;
    startTime?: string | null;
  }
) => {
  const group = await getGroupRow(client, groupId);
  if (!group || group.is_active === false) throw groupError('GROUP_NOT_FOUND', 404);

  await requireGroupAdmin(client, group, userId);

  const title = String(input.title ?? '').trim();
  if (title.length < 2 || title.length > 100) throw groupError('VALIDATION_FAILED', 400);

  const questionCount = clampInt(
    input.questionCount,
    10,
    MIN_BATTLE_QUESTIONS,
    MAX_BATTLE_QUESTIONS
  );
  const durationMinutes = clampInt(
    input.durationMinutes,
    20,
    1,
    MAX_BATTLE_DURATION_MINUTES
  );

  const startTime = input.startTime ? new Date(input.startTime) : new Date();
  if (Number.isNaN(startTime.getTime())) throw groupError('INVALID_START_TIME', 400);

  // A battle may start now (live) or in the near future; a far-past start would
  // be graded immediately, so it is rejected as invalid.
  if (startTime.getTime() < Date.now() - 60 * 1000) {
    throw groupError('INVALID_START_TIME', 400);
  }

  const questionIds = await selectGroupBattleQuestionIds({
    subjectId: input.subjectId ? normalizeId(input.subjectId) : null,
    chapterId: input.chapterId ? normalizeId(input.chapterId) : null,
    count: questionCount,
    userId,
  });

  if (questionIds.length < MIN_BATTLE_QUESTIONS) {
    throw groupError('INVALID_QUESTIONS', 400);
  }

  const { data, error } = await client.rpc('create_group_battle', {
    p_group_id: groupId,
    p_title: title,
    p_question_ids: questionIds,
    p_duration_minutes: durationMinutes,
    p_start_time: startTime.toISOString(),
    p_subject_id: input.subjectId ? normalizeId(input.subjectId) : null,
    p_chapter_id: input.chapterId ? normalizeId(input.chapterId) : null,
  });

  if (error) throw mapDataError(error);

  const battleId = typeof data === 'string' ? data : normalizeId(data);
  const battle = await loadBattle(client, battleId);

  await notifyBattleCreated(group, userId);

  return { id: battleId, battle: battle ? withState(battle, Date.now()) : null };
};

export const listGroupBattles = async (
  client: SupabaseClient,
  userId: string,
  groupId: string
) => {
  await requireActiveMember(client, groupId, userId);

  const { data, error } = await client
    .from('group_battles')
    .select(BATTLE_FIELDS)
    .eq('group_id', groupId)
    .order('start_time', { ascending: false })
    .limit(50);

  if (error) throw mapDataError(error);

  const battles = data || [];
  const battleIds = battles.map((battle: AnyObject) => normalizeId(battle.id));

  let myParticipations: AnyObject[] = [];
  if (battleIds.length > 0) {
    const { data: participantRows } = await client
      .from('group_battle_participants')
      .select('battle_id, status, score, correct_count, rank, time_taken, xp_awarded')
      .eq('user_id', userId)
      .in('battle_id', battleIds);
    myParticipations = participantRows || [];
  }

  const participationMap = new Map<string, AnyObject>(
    myParticipations.map((row: AnyObject) => [normalizeId(row.battle_id), row])
  );

  const nowMs = Date.now();

  return {
    battles: battles.map((battle: AnyObject) => ({
      ...withState(battle, nowMs),
      my_participation: participationMap.get(normalizeId(battle.id)) ?? null,
    })),
    serverNow: new Date(nowMs).toISOString(),
  };
};

export const getBattleDetail = async (
  client: SupabaseClient,
  userId: string,
  battleId: string
) => {
  const battle = await loadBattle(client, battleId);
  if (!battle) throw groupError('BATTLE_NOT_FOUND', 404);

  await requireActiveMember(client, battle.group_id, userId);

  const { data: participantRows, error } = await client
    .from('group_battle_participants')
    .select('id, battle_id, user_id, status, score, correct_count, wrong_count, time_taken, rank, xp_awarded, joined_at, submitted_at')
    .eq('battle_id', battleId);

  if (error) throw mapDataError(error);

  const rows = participantRows || [];
  const profileMap = await loadSafeProfiles(rows.map((row: AnyObject) => row.user_id));

  const standings: AnyObject[] = rows
    .map((row: AnyObject) => ({
      ...row,
      profile: profileMap.get(normalizeId(row.user_id)) ?? null,
    }))
    .sort((a: AnyObject, b: AnyObject) => {
      const rankA = typeof a.rank === 'number' ? a.rank : Number.MAX_SAFE_INTEGER;
      const rankB = typeof b.rank === 'number' ? b.rank : Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      const scoreDiff = Number(b.score ?? 0) - Number(a.score ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      return Number(a.time_taken ?? 0) - Number(b.time_taken ?? 0);
    });

  const winner = battle.winner_id ? profileMap.get(normalizeId(battle.winner_id)) ?? null : null;

  const nowMs = Date.now();

  return {
    battle: withState(battle, nowMs),
    participants: standings,
    standings,
    winner,
    myParticipation: standings.find((row) => normalizeId(row.user_id) === userId) ?? null,
    serverNow: new Date(nowMs).toISOString(),
  };
};

export const joinBattle = async (
  client: SupabaseClient,
  userId: string,
  battleId: string
) => {
  const battle = await loadBattle(client, battleId);
  if (!battle) throw groupError('BATTLE_NOT_FOUND', 404);

  await requireActiveMember(client, battle.group_id, userId);

  if (battle.status === 'cancelled') throw groupError('BATTLE_CANCELLED', 409);
  if (battle.status === 'completed') throw groupError('BATTLE_CLOSED', 409);

  const end = toEpoch(battle.end_time);
  if (end !== null && Date.now() >= end) throw groupError('BATTLE_CLOSED', 409);

  const { data, error } = await client.rpc('join_group_battle', { p_battle_id: battleId });
  if (error) throw mapDataError(error);

  // `join_group_battle` may return the question ids once the battle is live.
  // The dedicated /questions endpoint is the only delivery channel, so they are
  // stripped here unconditionally.
  const result = (data && typeof data === 'object' ? data : {}) as AnyObject;

  return {
    battle_id: normalizeId(result.battle_id ?? battleId),
    start_time: result.start_time ?? battle.start_time,
    end_time: result.end_time ?? battle.end_time,
    serverNow: new Date().toISOString(),
  };
};

export const getBattleQuestions = async (
  client: SupabaseClient,
  userId: string,
  battleId: string
) => {
  const battle = await loadBattle(client, battleId);
  if (!battle) throw groupError('BATTLE_NOT_FOUND', 404);

  await requireActiveMember(client, battle.group_id, userId);

  if (battle.status === 'cancelled') throw groupError('BATTLE_CANCELLED', 409);

  const participant = await loadParticipant(client, battleId, userId);
  if (!participant || participant.status === 'disqualified') {
    throw groupError('NOT_JOINED_OR_ALREADY_SUBMITTED', 409);
  }
  if (participant.status === 'submitted') throw groupError('BATTLE_CLOSED', 409);

  const nowMs = Date.now();
  const start = toEpoch(battle.start_time);
  const end = toEpoch(battle.end_time);

  if (start === null || nowMs < start) throw groupError('BATTLE_NOT_STARTED', 400);
  if (end === null || nowMs >= end) throw groupError('BATTLE_CLOSED', 409);

  const questionIds = await loadBattleQuestionIds(battleId);
  const questions = await loadGroupBattleQuestions(questionIds);

  return {
    battle_id: battleId,
    title: battle.title,
    duration_minutes: battle.duration_minutes,
    start_time: battle.start_time,
    end_time: battle.end_time,
    server_now: new Date(nowMs).toISOString(),
    questions: sanitizeQuestionsForClient(questions),
  };
};

export const submitBattleAnswers = async (
  client: SupabaseClient,
  userId: string,
  battleId: string,
  answers: Record<string, unknown>
) => {
  const battle = await loadBattle(client, battleId);
  if (!battle) throw groupError('BATTLE_NOT_FOUND', 404);

  await requireActiveMember(client, battle.group_id, userId);

  if (battle.status === 'cancelled') throw groupError('BATTLE_CANCELLED', 409);

  const nowMs = Date.now();
  const start = toEpoch(battle.start_time);
  const end = toEpoch(battle.end_time);

  if (start === null || nowMs < start) throw groupError('BATTLE_NOT_STARTED', 400);
  if (end === null || nowMs > end + FINALIZE_GRACE_MS) throw groupError('BATTLE_CLOSED', 409);

  const participant = await loadParticipant(client, battleId, userId);
  if (
    !participant ||
    participant.status === 'submitted' ||
    participant.status === 'disqualified'
  ) {
    throw groupError('NOT_JOINED_OR_ALREADY_SUBMITTED', 409);
  }

  const questionIds = await loadBattleQuestionIds(battleId);
  const questions = await loadGroupBattleQuestions(questionIds);
  if (questions.length === 0) throw groupError('INVALID_QUESTIONS', 409);

  const result = scoreBattleAnswers(questions, answers);
  const { score, correct_count: correct, wrong_count: wrong, skipped_count: skipped } = result;
  const timeTaken = computeTimeTaken(
    battle.start_time,
    nowMs,
    Number(battle.duration_minutes),
    MAX_BATTLE_DURATION_MINUTES
  );

  const { error } = await supabaseAdmin.rpc('record_group_battle_score', {
    p_battle_id: battleId,
    p_user_id: userId,
    p_score: score,
    p_correct_count: correct,
    p_wrong_count: wrong,
    p_time_taken: timeTaken,
    p_exam_history_id: null,
  });

  if (error) {
    const raw = String(error.message ?? '').trim();
    if (raw === 'NOT_JOINED_OR_ALREADY_SUBMITTED') {
      throw groupError('NOT_JOINED_OR_ALREADY_SUBMITTED', 409);
    }
    throw mapDataError(error);
  }

  return {
    battle_id: battleId,
    score,
    correct_count: correct,
    wrong_count: wrong,
    skipped_count: skipped,
    total_questions: questions.length,
    time_taken: timeTaken,
    submitted_at: new Date(nowMs).toISOString(),
    state: deriveBattleState(battle, nowMs),
    finalizable_at: finalizableAt(battle.end_time),
  };
};

export const cancelBattle = async (
  client: SupabaseClient,
  userId: string,
  battleId: string
) => {
  const battle = await loadBattle(client, battleId);
  if (!battle) throw groupError('BATTLE_NOT_FOUND', 404);

  const group = await getGroupRow(client, battle.group_id);
  if (!group) throw groupError('GROUP_NOT_FOUND', 404);

  await requireGroupAdmin(client, group, userId);

  const { error } = await client.rpc('cancel_group_battle', { p_battle_id: battleId });
  if (error) throw mapDataError(error);

  return { cancelled: true };
};

export const finalizeBattle = async (
  client: SupabaseClient,
  userId: string,
  battleId: string
) => {
  const battle = await loadBattle(client, battleId);
  if (!battle) throw groupError('BATTLE_NOT_FOUND', 404);

  await requireActiveMember(client, battle.group_id, userId);

  const nowMs = Date.now();
  const end = toEpoch(battle.end_time);
  if (end === null || nowMs < end + FINALIZE_GRACE_MS) {
    throw groupError('BATTLE_NOT_FINISHED', 409);
  }

  const wasCompleted = battle.status === 'completed';

  const { data, error } = await client.rpc('finalize_group_battle', { p_battle_id: battleId });
  if (error) throw mapDataError(error);

  // The RPC owns ranking and winner selection, so reload the authoritative row
  // instead of inferring the winner from the returned snapshot shape.
  const updatedBattle = (await loadBattle(client, battleId)) ?? battle;
  const group = await getGroupRow(client, battle.group_id).catch(() => null);
  const winnerId = normalizeId(updatedBattle.winner_id ?? data?.winner_id) || null;

  if (!wasCompleted) {
    await notifyBattleFinished(
      normalizeId(battle.group_id),
      String(group?.name ?? battle.title ?? 'Porokh'),
      winnerId
    );
  }

  return {
    snapshot: data ?? null,
    serverNow: new Date().toISOString(),
  };
};
