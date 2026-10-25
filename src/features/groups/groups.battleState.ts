/**
 * Derived battle state. Kept dependency-free so the same rules can be mirrored
 * by the student app (see `src/features/groups/utils/battleState.ts`).
 *
 *   upcoming  : pending && now < start_time
 *   live      : (pending|ongoing) && start_time <= now < end_time
 *   grading   : (pending|ongoing) && now >= end_time
 *   completed : completed (any time)
 *   cancelled : cancelled (any time)
 */
export type BattleState = 'upcoming' | 'live' | 'grading' | 'completed' | 'cancelled' | 'unknown';

const FINALIZE_GRACE_MS = 2 * 60 * 1000;

const toEpoch = (value: unknown): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

export const deriveBattleState = (
  battle: { status?: string | null; start_time?: string | null; end_time?: string | null } | null | undefined,
  nowMs: number = Date.now()
): BattleState => {
  if (!battle) return 'unknown';

  const status = String(battle.status ?? '').toLowerCase();

  if (status === 'cancelled') return 'cancelled';
  if (status === 'completed') return 'completed';

  const start = toEpoch(battle.start_time);
  const end = toEpoch(battle.end_time);

  if (start !== null && nowMs < start) return 'upcoming';
  if (start !== null && end !== null && nowMs >= start && nowMs < end) return 'live';
  if (end !== null && nowMs >= end) return 'grading';

  return 'unknown';
};

/** Earliest time at which the finalize RPC may be called. */
export const finalizableAt = (endTime: string | null | undefined): string | null => {
  const end = toEpoch(endTime);
  return end === null ? null : new Date(end + FINALIZE_GRACE_MS).toISOString();
};
