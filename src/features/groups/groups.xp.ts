import { supabaseAdmin } from '../../config/supabaseAdmin';

/**
 * Mirrors XP earned from a normal exam into every active group the student is
 * a member of.
 *
 * This runs from the exam-submit path and MUST never delay or fail a
 * submission, so callers invoke it fire-and-forget. Battle XP is intentionally
 * excluded: `finalize_group_battle` awards that XP itself.
 */
export const awardGroupXpToActiveGroups = async (userId: string, xp: number): Promise<void> => {
  if (!userId || !Number.isFinite(xp) || xp <= 0) return;

  try {
    const { data: memberships, error } = await supabaseAdmin
      .from('group_members')
      .select('group_id')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (error) {
      console.error('[groups:xp] membership lookup failed:', error.message);
      return;
    }

    const groupIds = Array.from(
      new Set(
        (memberships || [])
          .map((row) => (typeof row.group_id === 'string' ? row.group_id : ''))
          .filter(Boolean)
      )
    );

    await Promise.allSettled(
      groupIds.map((groupId) =>
        supabaseAdmin.rpc('award_group_xp', {
          p_group_id: groupId,
          p_user_id: userId,
          p_xp: Math.floor(xp),
        })
      )
    );
  } catch (error) {
    console.error(
      '[groups:xp] award failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
  }
};
