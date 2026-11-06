import { supabase } from '../../config/supabase';

/** Records only actor, action and resource identifiers; never stores tokens or request payloads. */
export const recordAdminAudit = async (
  actorId: string | undefined,
  action: string,
  resourceType: string,
  resourceId?: string,
  details: Record<string, unknown> = {}
) => {
  if (!actorId) {
    console.error('[security-audit] verified actor was unavailable');
    return;
  }
  const { error } = await supabase.from('audit_logs').insert([{
    user_id: actorId,
    action,
    target_table: resourceType,
    target_id: resourceId ?? null,
    details,
  }]);
  if (error) console.error('[security-audit] administrative event could not be recorded');
};
